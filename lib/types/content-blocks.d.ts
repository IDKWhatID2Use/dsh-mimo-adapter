/**
 * Content-block and modality vocabulary this plugin adds to the harness.
 *
 * The shipped harness vocabulary (`@deepseek-ai/dsh-llm`) declares only `text`
 * and `image` input modalities, and only text/image/file/tool content blocks.
 * Audio and video input therefore cannot be expressed through the shipped
 * types, and this file is the one place that widens them, using the same
 * merge-extensible pattern the harness itself documents:
 *
 * - `ContentBlockMap`  — "Merge-extensible content blocks keyed by `type`"
 * - `ModelModalityMap` — "Merge-extensible provider model modality vocabulary"
 *
 * Widening has two consequences the adapter honours:
 *
 * 1. `GenerateOptions.messages` may now carry `audio` / `video` blocks, so the
 *    harness `LlmRuntime` check on `prepared.inputModalities` can see a route
 *    that accepts them;
 * 2. every other adapter receives blocks it does not know. Those adapters
 *    switch on `type` and "fall through unknowns", so this plugin additionally
 *    installs an `llm/stream` waterfall that degrades them to deterministic
 *    text for routes it does not own (see `lib/degrade.js`).
 *
 * @module dsh-mimo-adapter/types
 */

declare module '@deepseek-ai/dsh-llm' {
    interface ModelModalityMap {
        /** Recorded audio sent as model input. */
        audio: 'audio';
        /** Recorded video sent as model input. */
        video: 'video';
    }
}

declare module '@deepseek-ai/dsh-llm/types' {
    interface ModelModalityMap {
        audio: 'audio';
        video: 'video';
    }
}

declare module '@deepseek-ai/dsh-llm' {
    interface ContentBlockMap {
        audio: import('./content-blocks.js').AudioBlock;
        video: import('./content-blocks.js').VideoBlock;
    }
}

declare module '@deepseek-ai/dsh-llm/types' {
    interface ContentBlockMap {
        audio: import('./content-blocks.js').AudioBlock;
        video: import('./content-blocks.js').VideoBlock;
    }
}

/**
 * A durable recorded-audio reference. Audio is stored verbatim as a file
 * attachment: the harness attachment service owns the bytes and this block
 * carries only the durable, content-addressed reference.
 */
export interface AudioBlock {
    type: 'audio';
    /** Immutable verbatim bytes and display metadata owned by the attachment service. */
    attachment: import('@deepseek-ai/dsh-attachment').FileAttachmentRef;
    /**
     * Media type as declared at admission (e.g. `audio/wav`). The attachment
     * service stores files byte-for-byte without normalizing them, so this is
     * the caller-declared container the adapter must either accept or refuse.
     * Absent means the deployment did not record a container.
     */
    mediaType?: string;
    /** Optional duration in milliseconds when the producer knows it. */
    durationMs?: number;
    /**
     * Set by an explicit omission decision; the adapter then sends placeholder
     * text instead of the bytes, exactly like an offloaded image.
     */
    offloaded?: true;
}

/** A durable recorded-video reference. See {@link AudioBlock} for the shared contract. */
export interface VideoBlock {
    type: 'video';
    attachment: import('@deepseek-ai/dsh-attachment').FileAttachmentRef;
    mediaType?: string;
    durationMs?: number;
    offloaded?: true;
}
