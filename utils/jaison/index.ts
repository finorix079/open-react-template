/**
 * Jaison - Optimized JSON parser with error tolerance
 * High-performance modular implementation
 * Source: inlined from jaison library
 *
 * @description Fault-tolerant JSON parser that handles malformed JSON,
 * markdown code blocks, Chinese punctuation, and various number formats
 * @version 2.0.0 (Optimized)
 */

import { tokenize } from './tokenizer';
import { parse } from './parser';

/**
 * Parse JSON-like string with high fault tolerance.
 * Handles malformed JSON, markdown code blocks, Chinese punctuation,
 * and various number formats (hex, binary, octal).
 *
 * @param {string} jsonString - Input string to parse
 * @returns {*} Parsed JavaScript value
 * @throws {Error} When input is invalid or contains unrecognized patterns
 *
 * @example
 * jaison('{"name": "test"}') // → { name: "test" }
 * jaison('{"name": "test"') // → { name: "test" }  (unclosed brace)
 * jaison('```json\n{"api": "success"}\n```') // → { api: "success" }
 * jaison('{"name"："测试"}') // → { name: "测试" }  (Chinese colon)
 * jaison('{"hex": 0xff}') // → { hex: 255 }
 */
export default function jaison(jsonString: string): any {
    if (jsonString === null || jsonString === undefined || typeof jsonString !== 'string') {
        throw new Error('Invalid input: jsonString must be a string');
    }

    // Remove markdown code block markers (common in AI responses)
    jsonString = jsonString.replace(/^\s*```[\w+\-]*\s*\n?/, '');
    jsonString = jsonString.replace(/\n?\s*```\s*$/i, '');

    const tokens = tokenize(jsonString);
    return parse(tokens);
}

export { jaison };