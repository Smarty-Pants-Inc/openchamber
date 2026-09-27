import { describe, expect, test } from 'bun:test';

import { getToolDescriptionFallback, isExpandableTool, isStaticTool } from './toolRenderUtils';

describe('tool rendering classification', () => {
    test('keeps navigation tools compact', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without direct navigation', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('todowrite')).toBe(true);
        expect(isExpandableTool('plan_exit')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isStaticTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
    });
});

describe('tool subtitle (smarty-code#538)', () => {
    test('a subtitle that only repeats the tool name is dropped; a Fabric display name replaces it', () => {
        expect(getToolDescriptionFallback('fabric_exec', 'fabric_exec', undefined)).toBe('');
        expect(getToolDescriptionFallback('presence', 'presence', {})).toBe('');
        expect(getToolDescriptionFallback('fabric_exec', 'fabric_exec', { display: { name: 'Read assignment' } })).toBe('Read assignment');
    });
    test('a real description still wins', () => {
        expect(getToolDescriptionFallback('fabric_exec', 'Post fits on #538', { display: { name: 'x' } })).toBe('Post fits on #538');
        expect(getToolDescriptionFallback('glob', '', { pattern: '**/*.ts' })).toBe('**/*.ts');
    });
});
