// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['read', 'skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }
    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: unknown): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const getToolDescriptionFallback = (
    toolName: unknown,
    description: unknown,
    input: Record<string, unknown> | undefined,
): string => {
    // smarty-code#538: a subtitle that only repeats the tool's name ("Fabric exec fabric_exec") is noise; a
    // Fabric program's own display name says what it did.
    if (typeof description === 'string' && description.trim().length > 0
        && normalizeToolName(description.trim()) !== normalizeToolName(toolName)) {
        return description;
    }
    const display = input?.display;
    const displayName = display && typeof display === 'object' ? (display as { name?: unknown }).name : undefined;
    if (typeof displayName === 'string' && displayName.trim()) return displayName.trim();

    const globPattern = normalizeToolName(toolName) === 'glob' ? input?.pattern : undefined;
    return typeof globPattern === 'string' ? globPattern : '';
};
