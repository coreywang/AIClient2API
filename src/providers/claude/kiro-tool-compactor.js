import logger from '../../utils/logger.js';

export const KIRO_TOOL_DESCRIPTION_MAX_CHARS = 2048;
export const KIRO_TOOL_SCHEMA_DESCRIPTION_MAX_CHARS = 512;
export const KIRO_TOOLS_CONTEXT_MAX_BYTES = 220000;

function jsonBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function truncateText(text, maxChars) {
    const rawText = String(text || '');
    if (rawText.length <= maxChars) {
        return rawText;
    }
    return `${rawText.slice(0, Math.max(0, maxChars))}...`;
}

export function sanitizeSchemaDescriptions(value, maxChars = KIRO_TOOL_SCHEMA_DESCRIPTION_MAX_CHARS, removeDescriptions = false) {
    if (Array.isArray(value)) {
        return value.map(item => sanitizeSchemaDescriptions(item, maxChars, removeDescriptions));
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    const result = {};
    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'description' && typeof childValue === 'string') {
            if (!removeDescriptions) {
                result[key] = truncateText(childValue, maxChars);
            }
            continue;
        }
        result[key] = sanitizeSchemaDescriptions(childValue, maxChars, removeDescriptions);
    }
    return result;
}

export function compactKiroToolsToBudget(kiroTools, maxBytes = KIRO_TOOLS_CONTEXT_MAX_BYTES) {
    if (!Array.isArray(kiroTools) || kiroTools.length === 0) {
        return kiroTools;
    }

    const toolsContext = () => ({ tools: kiroTools });
    const originalBytes = jsonBytes(toolsContext());
    if (originalBytes <= maxBytes) {
        return kiroTools;
    }

    logger.warn(`[Kiro] Tools payload ${originalBytes} bytes exceeds ${maxBytes}, applying compact tool metadata`);

    for (const descriptionLimit of [1024, 512]) {
        for (const tool of kiroTools) {
            const spec = tool.toolSpecification;
            spec.description = truncateText(spec.description, descriptionLimit);
        }
        const bytes = jsonBytes(toolsContext());
        logger.info(`[Kiro] Tools payload after description cap ${descriptionLimit}: ${bytes} bytes`);
        if (bytes <= maxBytes) {
            return kiroTools;
        }
    }

    for (const schemaDescriptionLimit of [256, 128]) {
        for (const tool of kiroTools) {
            const schema = tool.toolSpecification?.inputSchema?.json;
            if (schema) {
                tool.toolSpecification.inputSchema.json = sanitizeSchemaDescriptions(schema, schemaDescriptionLimit);
            }
        }
        const bytes = jsonBytes(toolsContext());
        logger.info(`[Kiro] Tools payload after schema description cap ${schemaDescriptionLimit}: ${bytes} bytes`);
        if (bytes <= maxBytes) {
            return kiroTools;
        }
    }

    for (const tool of kiroTools) {
        const schema = tool.toolSpecification?.inputSchema?.json;
        if (schema) {
            tool.toolSpecification.inputSchema.json = sanitizeSchemaDescriptions(schema, 0, true);
        }
    }
    let bytes = jsonBytes(toolsContext());
    logger.info(`[Kiro] Tools payload after removing schema descriptions: ${bytes} bytes`);
    if (bytes <= maxBytes) {
        return kiroTools;
    }

    const toolsBySchemaSize = [...kiroTools]
        .map(tool => ({ tool, bytes: jsonBytes(tool.toolSpecification?.inputSchema?.json || {}) }))
        .sort((a, b) => b.bytes - a.bytes);

    for (const { tool } of toolsBySchemaSize) {
        const spec = tool.toolSpecification;
        const before = jsonBytes(spec.inputSchema?.json || {});
        spec.inputSchema = { json: { type: 'object', properties: {} } };
        bytes = jsonBytes(toolsContext());
        logger.warn(`[Kiro] Simplified oversized tool schema '${spec.name}' (${before} bytes); tools payload now ${bytes} bytes`);
        if (bytes <= maxBytes) {
            return kiroTools;
        }
    }

    logger.warn(`[Kiro] Tools payload remains ${bytes} bytes after maximum compaction`);
    return kiroTools;
}
