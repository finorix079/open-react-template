/**
 * Optimized parser for tokenized JSON-like structures
 * Maintains all original functionality while improving performance
 * Source: inlined from jaison library
 */

import {
    TRUE_ALIAS,
    FALSE_ALIAS,
    NULL_ALIAS,
    UNDEFINED_ALIAS,
    TOKEN_TYPES,
    CONTAINER_TYPES,
    RADIX
} from './constants';

interface Token {
    type: string;
    value: string;
    radix?: number;
    isNegative?: boolean;
    isPositive?: boolean;
}

interface Container {
    type: string;
    value: any;
    _key?: string;
}

interface BracketResult {
    shouldReturn: boolean;
    value?: any;
    newContainer?: Container;
    skipNext?: boolean;
}

interface KeyResult {
    isKey?: boolean;
    shouldContinue?: boolean;
    shouldThrow?: boolean;
    key?: string;
}

interface PunctuationResult {
    shouldThrow?: boolean;
    shouldContinue?: boolean;
}

interface AssignResult {
    shouldReturn: boolean;
    value?: any;
    skipNext?: boolean;
}

/**
 * Parse tokens into JavaScript objects/values
 * @param {Array} tokens - Array of token objects from tokenizer
 * @returns {*} Parsed JavaScript value
 */
export function parse(tokens: Token[]): any {
    const stacks: Container[] = [];
    let currentContainer: Container | null = null;
    const tokenLength = tokens.length;

    for (let i = 0; i < tokenLength; i++) {
        const token = tokens[i];

        // Handle bracket tokens (container creation/closing)
        if (token.type === TOKEN_TYPES.BRACKET) {
            const result = handleBracketToken(token, currentContainer, stacks, tokens, i, tokenLength);

            if (result.shouldReturn) {
                return result.value;
            }

            if (result.newContainer !== undefined) {
                currentContainer = result.newContainer;
            }

            if (result.skipNext) {
                i++;
            }

            continue;
        }

        // Handle object key parsing
        if (currentContainer &&
            currentContainer.type === CONTAINER_TYPES.OBJECT &&
            currentContainer._key === undefined) {

            const keyResult = handleObjectKey(token);
            if (keyResult.isKey) {
                currentContainer._key = keyResult.key;
                continue;
            } else if (keyResult.shouldContinue) {
                continue;
            } else if (keyResult.shouldThrow) {
                throw new Error(`Unexpected token "${token.value}" when expecting a key in an object`);
            }
        }

        // Handle punctuation tokens
        if (token.type === TOKEN_TYPES.PUNCTUATION) {
            const punctuationResult = handlePunctuationToken(token, tokens, i, tokenLength, currentContainer, stacks);

            if (punctuationResult.shouldThrow) {
                throw new Error('Unexpected punctuation outside of object or array context');
            }

            if (punctuationResult.shouldContinue) {
                continue;
            }
        }

        // Parse value tokens
        let value: any;

        // Special handling for consecutive identifiers in array/object value context
        if (token.type === TOKEN_TYPES.IDENTIFIER && currentContainer) {
            const identifierValues = [token.value];
            let j = i + 1;

            while (j < tokenLength && tokens[j].type === TOKEN_TYPES.IDENTIFIER) {
                identifierValues.push(tokens[j].value);
                j++;
            }

            if (identifierValues.length > 1) {
                value = identifierValues.join(' ');
                i = j - 1;
            } else {
                value = parseValueToken(token);
            }
        } else {
            value = parseValueToken(token);
        }

        // Assign value to current container or return if top-level
        const assignResult = assignValue(value, currentContainer, tokens, i, tokenLength);

        if (assignResult.shouldReturn) {
            return assignResult.value;
        }

        if (assignResult.skipNext) {
            i++;
        }
    }

    return handleUnclosedContainers(stacks, currentContainer);
}

/**
 * Handle bracket tokens for container creation and closing
 */
function handleBracketToken(token: Token, currentContainer: Container | null, stacks: Container[], tokens: Token[], index: number, tokenLength: number): BracketResult {
    if (token.value === '{') {
        return createObjectContainer(currentContainer, stacks);
    } else if (token.value === '}') {
        return closeContainer(stacks, tokens, index, tokenLength, 'Unmatched closing brace "}"');
    } else if (token.value === '[') {
        return createArrayContainer(currentContainer, stacks);
    } else if (token.value === ']') {
        return closeContainer(stacks, tokens, index, tokenLength, 'Unmatched closing bracket "]"');
    }

    return { shouldReturn: false };
}

/**
 * Create new object container
 */
function createObjectContainer(currentContainer: Container | null, stacks: Container[]): BracketResult {
    const newContainer: Container = {
        type: CONTAINER_TYPES.OBJECT,
        value: {}
    };

    if (currentContainer) {
        if (currentContainer.type === CONTAINER_TYPES.OBJECT && currentContainer._key !== undefined) {
            currentContainer.value[currentContainer._key] = newContainer.value;
            delete currentContainer._key;
        } else if (currentContainer.type === CONTAINER_TYPES.ARRAY) {
            currentContainer.value.push(newContainer.value);
        }
    }

    stacks.push(newContainer);
    return { shouldReturn: false, newContainer };
}

/**
 * Create new array container
 */
function createArrayContainer(currentContainer: Container | null, stacks: Container[]): BracketResult {
    const newContainer: Container = {
        type: CONTAINER_TYPES.ARRAY,
        value: []
    };

    if (currentContainer) {
        if (currentContainer.type === CONTAINER_TYPES.OBJECT && currentContainer._key !== undefined) {
            currentContainer.value[currentContainer._key] = newContainer.value;
            delete currentContainer._key;
        } else if (currentContainer.type === CONTAINER_TYPES.ARRAY) {
            currentContainer.value.push(newContainer.value);
        }
    }

    stacks.push(newContainer);
    return { shouldReturn: false, newContainer };
}

/**
 * Close current container
 */
function closeContainer(stacks: Container[], tokens: Token[], index: number, tokenLength: number, errorMessage: string): BracketResult {
    if (stacks.length > 0) {
        const completedContainer = stacks.pop();

        if (stacks.length > 0) {
            const skipNext = (index + 1 < tokenLength && tokens[index + 1].value === ',');
            return {
                shouldReturn: false,
                newContainer: stacks[stacks.length - 1],
                skipNext
            };
        } else {
            return {
                shouldReturn: true,
                value: completedContainer?.value
            };
        }
    } else {
        throw new Error(errorMessage);
    }
}

/**
 * Handle object key parsing
 */
function handleObjectKey(token: Token): KeyResult {
    switch (token.type) {
        case TOKEN_TYPES.STRING:
            return { isKey: true, key: parseStringValue(token) };

        case TOKEN_TYPES.NUMBER:
        case TOKEN_TYPES.IDENTIFIER:
            if (token.type === TOKEN_TYPES.NUMBER && token.isNegative) {
                return { isKey: true, key: '-' + token.value };
            } else if (token.type === TOKEN_TYPES.NUMBER && token.isPositive) {
                return { isKey: true, key: '+' + token.value };
            } else {
                return { isKey: true, key: token.value };
            }

        case TOKEN_TYPES.PUNCTUATION:
            if (token.value === ',') {
                return { shouldContinue: true };
            }
            return { shouldThrow: true };

        default:
            return { shouldThrow: true };
    }
}

/**
 * Handle punctuation tokens
 */
function handlePunctuationToken(token: Token, tokens: Token[], index: number, tokenLength: number, currentContainer: Container | null, stacks: Container[]): PunctuationResult {
    if (stacks.length === 0) {
        return { shouldThrow: true };
    }

    if (token.value === ',') {
        if (currentContainer && currentContainer.type === CONTAINER_TYPES.ARRAY) {
            currentContainer.value.push(null);
        }
        return { shouldContinue: true };
    } else if (token.value === ':') {
        if (index + 1 < tokenLength) {
            const nextToken = tokens[index + 1];
            if (nextToken.value === ',' || nextToken.value === '}') {
                if (currentContainer &&
                    currentContainer.type === CONTAINER_TYPES.OBJECT &&
                    currentContainer._key !== undefined) {
                    currentContainer.value[currentContainer._key] = null;
                    delete currentContainer._key;
                }
            }
        } else {
            if (currentContainer &&
                currentContainer.type === CONTAINER_TYPES.OBJECT &&
                currentContainer._key !== undefined) {
                currentContainer.value[currentContainer._key] = null;
                delete currentContainer._key;
            }
        }
        return { shouldContinue: true };
    }

    return { shouldContinue: true };
}

/**
 * Parse value from token
 */
function parseValueToken(token: Token): any {
    switch (token.type) {
        case TOKEN_TYPES.IDENTIFIER:
            return parseIdentifierValue(token);

        case TOKEN_TYPES.STRING:
            return parseStringValue(token);

        case TOKEN_TYPES.NUMBER:
            return parseNumberValue(token);

        default:
            return null;
    }
}

/**
 * Parse identifier value with alias support
 */
function parseIdentifierValue(token: Token): any {
    const tokenValue = token.value;
    const tokenValueLower = tokenValue.toLowerCase();

    if (TRUE_ALIAS.has(tokenValueLower)) {
        return true;
    } else if (FALSE_ALIAS.has(tokenValueLower)) {
        return false;
    } else if (NULL_ALIAS.has(tokenValueLower)) {
        return null;
    } else if (UNDEFINED_ALIAS.has(tokenValueLower)) {
        return undefined;
    } else {
        return tokenValue;
    }
}

/**
 * Parse string value with control character escaping
 */
function parseStringValue(token: Token): string {
    let stringValue = token.value;

    stringValue = stringValue.replace(/[\x00-\x1F]/g, function(match) {
        const code = match.charCodeAt(0);
        return '\\u' + ('000' + code.toString(16)).slice(-4);
    });

    return JSON.parse(stringValue);
}

/**
 * Parse number value with radix support
 */
function parseNumberValue(token: Token): number {
    const numValue = token.value;
    let value: number;

    if (token.radix === RADIX.HEXADECIMAL) {
        value = parseInt(numValue, 16);
    } else if (token.radix === RADIX.OCTAL) {
        value = parseInt(numValue.slice(2), 8);
    } else if (token.radix === RADIX.BINARY) {
        value = parseInt(numValue.slice(2), 2);
    } else {
        value = parseFloat(numValue);
    }

    if (token.isNegative) {
        value = -value;
    }

    return value;
}

/**
 * Assign parsed value to container or return as top-level value
 */
function assignValue(value: any, currentContainer: Container | null, tokens: Token[], index: number, tokenLength: number): AssignResult {
    if (currentContainer) {
        if (currentContainer.type === CONTAINER_TYPES.OBJECT) {
            currentContainer.value[currentContainer._key!] = value;
            delete currentContainer._key;
        } else {
            currentContainer.value.push(value);
        }

        const skipNext = (index + 1 < tokenLength && tokens[index + 1].value === ',');
        return { shouldReturn: false, skipNext };
    } else {
        return { shouldReturn: true, value };
    }
}

/**
 * Handle unclosed containers at end of parsing
 */
function handleUnclosedContainers(stacks: Container[], currentContainer: Container | null): any {
    if (stacks.length > 0) {
        if (currentContainer &&
            currentContainer.type === CONTAINER_TYPES.OBJECT &&
            currentContainer._key !== undefined) {
            currentContainer.value[currentContainer._key] = null;
            delete currentContainer._key;
        }
        return stacks[0].value;
    }

    return undefined;
}
