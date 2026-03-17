/**
 * Optimized tokenizer for JSON-like strings
 * Replaces complex regex with manual character-by-character parsing
 * Source: inlined from jaison library
 */

import { TOKEN_TYPES, RADIX } from './constants';

interface Token {
    type: string;
    value: string;
    radix?: number;
    isNegative?: boolean;
    isPositive?: boolean;
}

interface TokenResult {
    token: Token | null;
    newPos: number;
}

interface StringTokenResult {
    token: Token;
    newPos: number;
    skippedBadEscape?: boolean;
}

interface NumberTokenResult {
    token: Token;
    newPos: number;
}

interface CommentResult {
    isComment: boolean;
    newPos: number;
}

/**
 * Tokenize JSON string using optimized manual parsing
 * @param {string} jsonString - Input string to tokenize
 * @returns {Array} Array of token objects
 */
export function tokenize(jsonString: string): Token[] {
    const tokens: Token[] = [];
    const len = jsonString.length;
    let pos = 0;

    while (pos < len) {
        const char = jsonString[pos];

        // Skip whitespace - optimized check
        if (char <= ' ') {
            pos++;
            continue;
        }

        // Skip comments (both single-line and multi-line)
        if (char === '/') {
            const commentResult = skipComment(jsonString, pos);
            if (commentResult.isComment) {
                pos = commentResult.newPos;
                continue;
            }
        }

        // String tokens (both double and single quotes)
        if (char === '"' || char === "'") {
            const stringToken = parseStringToken(jsonString, pos);
            tokens.push(stringToken.token);
            pos = stringToken.newPos;

            // If we terminated early due to bad escape, skip the \' or \" and optional punctuation
            if (stringToken.skippedBadEscape) {
                if (pos < len && jsonString[pos] === '\\' && pos + 1 < len && (jsonString[pos + 1] === '"' || jsonString[pos + 1] === "'")) {
                    pos += 2;
                    if (pos < len && (jsonString[pos] === ',' || jsonString[pos] === ':')) {
                        pos++;
                    }
                }
            }
            continue;
        }

        // Bracket tokens
        if (char === '{' || char === '}' || char === '[' || char === ']') {
            tokens.push({
                type: TOKEN_TYPES.BRACKET,
                value: char
            });
            pos++;
            continue;
        }

        // Punctuation tokens (including Chinese punctuation)
        if (char === ',' || char === ':' || char === '：' || char === '，') {
            const punctuationToken = parsePunctuationToken(char);
            tokens.push(punctuationToken);
            pos++;
            continue;
        }

        // Number tokens (with proper radix and negative sign tracking)
        if ((char >= '0' && char <= '9') || char === '-' || char === '+' || char === '.') {
            const numberToken = parseNumberToken(jsonString, pos);
            tokens.push(numberToken.token);
            pos = numberToken.newPos;
            continue;
        }

        // Identifier tokens
        const identifierToken = parseIdentifierToken(jsonString, pos);
        if (identifierToken.token) {
            tokens.push(identifierToken.token);
        }
        pos = identifierToken.newPos;
    }

    return tokens;
}

/**
 * Parse string token with proper escape handling for both single and double quotes
 * @param {string} jsonString - Input string
 * @param {number} startPos - Starting position
 * @returns {Object} Token and new position
 */
function parseStringToken(jsonString: string, startPos: number): StringTokenResult {
    const len = jsonString.length;
    const quoteChar = jsonString[startPos];
    let pos = startPos + 1;
    let tokenValue: string;
    let foundEarlyTermination = false;

    while (pos < len) {
        const c = jsonString[pos];
        if (c === quoteChar) {
            pos++;
            break;
        } else if (c === '\\') {
            pos += 2;
        } else if (c === '\n' || c === '\r') {
            const beforeNewline = jsonString.slice(startPos + 1, pos);
            const matchEscapedQuote = /\\["']([,:])?$/.exec(beforeNewline);

            if (matchEscapedQuote) {
                const contentBeforeEscape = beforeNewline.substring(0, matchEscapedQuote.index);
                tokenValue = quoteChar + contentBeforeEscape + quoteChar;
                pos = startPos + 1 + matchEscapedQuote.index;
                foundEarlyTermination = true;
                break;
            } else {
                pos++;
            }
        } else {
            pos++;
        }
    }

    if (!foundEarlyTermination) {
        tokenValue = jsonString.slice(startPos, pos);

        if (!tokenValue.endsWith(quoteChar)) {
            tokenValue += quoteChar;
        }
    }

    // Normalize single quotes to double quotes for JSON compatibility
    if (quoteChar === "'") {
        const innerContent = tokenValue.slice(1, -1);

        let escapedContent = '';
        for (let i = 0; i < innerContent.length; i++) {
            const char = innerContent[i];
            if (char === '"') {
                if (i === 0 || innerContent[i - 1] !== '\\') {
                    escapedContent += '\\"';
                } else {
                    escapedContent += char;
                }
            } else {
                escapedContent += char;
            }
        }

        tokenValue = '"' + escapedContent + '"';
    }

    return {
        token: {
            type: TOKEN_TYPES.STRING,
            value: tokenValue
        },
        newPos: pos,
        skippedBadEscape: foundEarlyTermination
    };
}

/**
 * Parse punctuation token with Chinese character normalization
 * @param {string} char - Punctuation character
 * @returns {Object} Token object
 */
function parsePunctuationToken(char: string): Token {
    let normalizedPunctuation = char;
    if (char === '：') {
        normalizedPunctuation = ':';
    } else if (char === '，') {
        normalizedPunctuation = ',';
    }

    return {
        type: TOKEN_TYPES.PUNCTUATION,
        value: normalizedPunctuation
    };
}

/**
 * Parse number token with radix detection and negative sign tracking
 * @param {string} jsonString - Input string
 * @param {number} startPos - Starting position
 * @returns {Object} Token and new position
 */
function parseNumberToken(jsonString: string, startPos: number): NumberTokenResult {
    const len = jsonString.length;
    let pos = startPos;
    let isNegative = false;
    let isPositive = false;
    let radix: number = RADIX.DECIMAL;

    if (jsonString[pos] === '-') {
        isNegative = true;
        pos++;
    } else if (jsonString[pos] === '+') {
        isPositive = true;
        pos++;
    }

    if (pos >= len) {
        return parseIdentifierToken(jsonString, startPos) as NumberTokenResult;
    }

    const firstChar = jsonString[pos];

    if (jsonString[startPos] === '.' || (pos > startPos && firstChar === '.')) {
        if (firstChar === '.' && pos + 1 < len && jsonString[pos + 1] >= '0' && jsonString[pos + 1] <= '9') {
            pos++;
            while (pos < len && /[\d.eE+-]/.test(jsonString[pos])) pos++;
        } else {
            return parseIdentifierToken(jsonString, startPos) as NumberTokenResult;
        }
    } else if (firstChar >= '0' && firstChar <= '9') {
        if (firstChar === '0' && pos < len - 1) {
            const nextChar = jsonString[pos + 1];
            if (nextChar === 'x' || nextChar === 'X') {
                radix = RADIX.HEXADECIMAL;
                pos += 2;
                while (pos < len && /[0-9a-fA-F]/.test(jsonString[pos])) pos++;
            } else if (nextChar === 'o' || nextChar === 'O') {
                radix = RADIX.OCTAL;
                pos += 2;
                while (pos < len && /[0-7]/.test(jsonString[pos])) pos++;
            } else if (nextChar === 'b' || nextChar === 'B') {
                radix = RADIX.BINARY;
                pos += 2;
                while (pos < len && /[01]/.test(jsonString[pos])) pos++;
            } else {
                pos++;
                while (pos < len && /[\d.eE+-]/.test(jsonString[pos])) pos++;
            }
        } else {
            while (pos < len && /[\d.eE+-]/.test(jsonString[pos])) pos++;
        }
    } else {
        return parseIdentifierToken(jsonString, startPos) as NumberTokenResult;
    }

    const numberValue = jsonString.slice(isNegative || isPositive ? startPos + 1 : startPos, pos);

    return {
        token: {
            type: TOKEN_TYPES.NUMBER,
            value: numberValue,
            radix: radix,
            isNegative: isNegative,
            isPositive: isPositive
        },
        newPos: pos
    };
}

/**
 * Parse identifier token
 * @param {string} jsonString - Input string
 * @param {number} startPos - Starting position
 * @returns {Object} Token and new position
 */
function parseIdentifierToken(jsonString: string, startPos: number): TokenResult {
    const len = jsonString.length;
    let pos = startPos;

    while (pos < len && !/["{}[\],:：，\s]/.test(jsonString[pos])) {
        pos++;
    }

    if (pos > startPos) {
        return {
            token: {
                type: TOKEN_TYPES.IDENTIFIER,
                value: jsonString.slice(startPos, pos)
            },
            newPos: pos
        };
    } else {
        return {
            token: null,
            newPos: pos + 1
        };
    }
}

/**
 * Skip comment tokens (both single-line and multi-line)
 * @param {string} jsonString - Input string
 * @param {number} startPos - Starting position (should be '/')
 * @returns {Object} isComment flag and new position
 */
function skipComment(jsonString: string, startPos: number): CommentResult {
    const len = jsonString.length;

    if (startPos + 1 >= len) {
        return { isComment: false, newPos: startPos + 1 };
    }

    const nextChar = jsonString[startPos + 1];

    if (nextChar === '/') {
        let pos = startPos + 2;
        while (pos < len && jsonString[pos] !== '\n' && jsonString[pos] !== '\r') {
            pos++;
        }
        if (pos < len && (jsonString[pos] === '\n' || jsonString[pos] === '\r')) {
            pos++;
            if (pos < len && jsonString[pos - 1] === '\r' && jsonString[pos] === '\n') {
                pos++;
            }
        }
        return { isComment: true, newPos: pos };
    }

    if (nextChar === '*') {
        let pos = startPos + 2;
        while (pos < len - 1) {
            if (jsonString[pos] === '*' && jsonString[pos + 1] === '/') {
                pos += 2;
                break;
            }
            pos++;
        }
        if (pos >= len - 1 && !(jsonString[pos - 1] === '*' && jsonString[pos] === '/')) {
            pos = len;
        }
        return { isComment: true, newPos: pos };
    }

    return { isComment: false, newPos: startPos };
}
