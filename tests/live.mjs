/**
 * Live verification against the real MiMo endpoint.
 *
 * Skipped unless `MIMO_LIVE=1` (and a credential is available), because it
 * spends real quota. Everything it checks is a wire fact the official docs
 * state, so a PASS here means the plugin speaks the documented protocol:
 *
 * 1. the official endpoint and `api-key` header authenticate;
 * 2. `thinking.type` is the accepted switch, and `disabled` really disables;
 * 3. `max_completion_tokens` is accepted (MiMo's own samples use it);
 * 4. a custom `temperature` is omitted while thinking is on;
 * 5. an agent-style tool-call round trip works, which is where the
 *    `reasoning_content`-on-replay requirement bites.
 *
 * Run: `MIMO_LIVE=1 node tests/live.mjs`
 * A missing credential is reported as SKIP, never as PASS.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { MiMoAdapter } from '../lib/adapter.js';
import { resolveConfig } from '../lib/config.js';
import { collect } from './helpers.mjs';

const results = [];
function record(name, status, detail) {
    results.push({ name, status, detail });
    console.log(`${status === 'PASS' ? '✔' : status === 'SKIP' ? '○' : '✖'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

if (process.env.MIMO_LIVE !== '1') {
    console.log('SKIP dsh-mimo-adapter live checks: set MIMO_LIVE=1 to spend real quota');
    process.exit(0);
}

/** Resolve the credential from the environment, then the harness credentials file. */
function resolveKey() {
    for (const name of ['MIMO_API_KEY', 'XIAOMI_API_KEY']) {
        const fromEnv = process.env[name]?.trim();
        if (fromEnv) return fromEnv;
    }
    const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');
    try {
        const text = readFileSync(path, 'utf8');
        for (const name of ['XIAOMI_API_KEY', 'MIMO_API_KEY']) {
            const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm').exec(text);
            if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
        }
    } catch {
        return undefined;
    }
    return undefined;
}

const apiKey = resolveKey();
if (apiKey === undefined) {
    console.log('SKIP dsh-mimo-adapter live checks: no MIMO_API_KEY / XIAOMI_API_KEY in the environment or $DSH_HOME/.credentials.yaml');
    process.exit(0);
}

const connection = resolveConfig({});
console.log(`endpoint: ${connection.baseURL}${connection.path}`);
console.log(`credential: ${apiKey.slice(0, 3)}… (${apiKey.length} chars)\n`);

const MODEL = process.env.MIMO_LIVE_MODEL ?? 'mimo-v2.6-flash';

function makeLiveAdapter() {
    const captures = [];
    const adapter = new MiMoAdapter({
        options: () => connection,
        resolveApiKey: async () => apiKey,
        resolveAttachments: () => undefined,
        imageAccess: () => undefined,
        logger: { warn: (message) => console.log(`   warn: ${message}`), error: (message) => console.log(`   error: ${message}`) },
        fetchImpl: async (url, init) => {
            captures.push({ url: String(url), init });
            return globalThis.fetch(url, init);
        },
    });
    return { adapter, captures };
}

async function ask(request, message = 'Reply with the single word: ok') {
    const { adapter, captures } = makeLiveAdapter();
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: MODEL,
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: message ?? 'Reply with the single word: ok' }], source: { kind: 'user' } }],
        ...request,
    }));
    const finish = chunks.at(-1);
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
    const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('');
    return { chunks, finish, text, reasoning, body: JSON.parse(captures[0].init.body), headers: captures[0].init.headers, url: captures[0].url };
}

// 1 + 3: the endpoint, the api-key header, and max_completion_tokens.
try {
    const first = await ask({ reasoningEffort: 'off' });
    record('the official endpoint accepts the api-key header', first.finish?.reason?.kind === 'stop' ? 'PASS' : 'FAIL',
        first.finish?.reason?.kind === 'stop' ? `${first.text.trim().slice(0, 40)}` : `${first.finish?.reason?.failure?.code}: ${first.finish?.reason?.failure?.message}`);
    record('the request carries max_completion_tokens', 'max_completion_tokens' in first.body ? 'PASS' : 'FAIL',
        `max_completion_tokens=${first.body.max_completion_tokens}`);
    record('thinking disabled really disables', (!first.reasoning || first.reasoning.trim().length === 0) ? 'PASS' : 'FAIL',
        `reasoning chars=${first.reasoning.length}`);
    record('temperature is unset when the caller sets none', first.body.temperature === undefined ? 'PASS' : 'FAIL',
        String(first.body.temperature));
} catch (error) {
    record('the official endpoint accepts the api-key header', 'FAIL', error.message);
}

// 2: the thinking switch actually changes behaviour.
try {
    const on = await ask({ reasoningEffort: 'high' }, 'What is 17 * 23? Think it through.');
    record('thinking enabled is accepted and streams reasoning', (on.finish?.reason?.kind === 'stop' && on.reasoning.length > 0) ? 'PASS' : 'FAIL',
        `reasoning chars=${on.reasoning.length}, answer=${on.text.trim().slice(0, 30)}`);
    record('thinking sends thinking.type = enabled', on.body.thinking?.type === 'enabled' ? 'PASS' : 'FAIL', JSON.stringify(on.body.thinking));
} catch (error) {
    record('thinking enabled is accepted and streams reasoning', 'FAIL', error.message);
}

// 4: the documented temperature restriction.
try {
    const withTemp = await ask({ reasoningEffort: 'high', temperature: 0.3 }, 'Say hi.');
    record('a custom temperature is not sent while thinking is on', withTemp.body.temperature === undefined ? 'PASS' : 'FAIL',
        String(withTemp.body.temperature));
} catch (error) {
    record('a custom temperature is not sent while thinking is on', 'FAIL', error.message);
}

// 5: the agent-shaped round trip, where reasoning_content replay is mandatory.
try {
    const tools = [{
        name: 'get_time',
        description: 'Return the current time in a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }];
    const call = await ask({ reasoningEffort: 'high', tools }, 'What time is it in Wuhan? Use the tool.');
    const toolCall = call.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
    if (toolCall === undefined) {
        record('a tool-call round trip replays reasoning_content', 'SKIP', 'the model answered without calling the tool');
    } else {
        record('the model issues a tool call', 'PASS', `${toolCall.block.name}(${toolCall.block.arguments}) id=${JSON.stringify(toolCall.block.id)}`);
        const { adapter, captures } = makeLiveAdapter();
        const followUpChunks = await collect(adapter.stream({
            provider: 'xiaomi',
            model: MODEL,
            reasoningEffort: 'high',
            messages: [
                {
                    id: 'a',
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: call.reasoning },
                        { type: 'tool-call', id: toolCall.block.id, name: toolCall.block.name, arguments: toolCall.block.arguments },
                    ],
                    source: { kind: 'model', provider: 'xiaomi', model: MODEL },
                },
                {
                    id: 'b',
                    role: 'user',
                    content: [{ type: 'tool-result', toolCallId: toolCall.block.id, content: [{ type: 'text', text: '2026-09-22 23:30' }] }],
                    source: { kind: 'tool', callId: toolCall.block.id },
                },
            ],
        }));
        const replay = JSON.parse(captures[0].init.body).messages[0];
        record('the replayed assistant turn carries reasoning_content', replay.reasoning_content !== undefined ? 'PASS' : 'FAIL',
            `${String(replay.reasoning_content).length} chars`);
        record('the replayed assistant turn carries a tool_call id', typeof replay.tool_calls?.[0]?.id === 'string' && replay.tool_calls[0].id.length > 0 ? 'PASS' : 'FAIL',
            JSON.stringify(replay.tool_calls?.[0] ?? null));
        record('the tool follow-up is accepted', followUpChunks.at(-1)?.reason?.kind === 'stop' ? 'PASS' : 'FAIL',
            `${followUpChunks.at(-1)?.reason?.kind}: ${followUpChunks.at(-1)?.reason?.failure?.message ?? followUpChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('').trim().slice(0, 40)}`);
    }
} catch (error) {
    record('a tool-call round trip replays reasoning_content', 'FAIL', error.message);
}

const failed = results.filter((entry) => entry.status === 'FAIL');
const skipped = results.filter((entry) => entry.status === 'SKIP');
console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
process.exitCode = failed.length === 0 ? 0 : 1;
