/**
 * messageUtils.ts
 * Utility functions for message summarization, filtering, and context serialization.
 */
import { Message, RequestContext } from '@/services/chatPlannerService';
import { kimiChatCompletion } from '@/utils/aiHandler';

/**
 * Serializes useful data entries in chronological order (earliest first).
 */
export function serializeUsefulDataInOrder(context: RequestContext): string {
  if (!context.usefulDataArray || context.usefulDataArray.length === 0) {
    return '{}';
  }

  const orderedEntries: Array<[string, string]> = context.usefulDataArray
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(item => [item.key, item.data]);

  const orderedObj = Object.fromEntries(orderedEntries);
  return JSON.stringify(orderedObj, null, 2);
}

/**
 * Estimates token count for a string (rough estimate: 1 token ≈ 4 characters).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Summarizes a single message while preserving all critical data points.
 * Short messages and system messages are returned unchanged.
 */
export async function summarizeMessage(message: Message, apiKey: string): Promise<Message> {
  if (message.content.length < 500 || message.role === 'system') {
    return message;
  }

  try {
    const summarized = await kimiChatCompletion({
      messages: [
        {
          role: 'system',
          content: `You are a message summarizer that extracts ONLY critical information from conversation messages.

CRITICAL RULES - NO DATA LOSS PERMITTED:
1. Preserve ALL numbers, IDs, quantities, counts, statistics (e.g., "125 moves", "ID: 25", "3 Pokémon")
2. Preserve ALL names: Pokémon names, move names, ability names, team names, item names
3. Preserve ALL specific entities and identifiers (e.g., "Pikachu", "Thunderbolt", "Static")
4. Preserve ALL data values, measurements, and attributes (e.g., "Electric-type", "power: 90")
5. Preserve ALL relationships and associations (e.g., "Pikachu's moves", "team members", "in watchlist")
6. Preserve ALL lists and enumerations completely (e.g., if 10 items mentioned, keep all 10)
7. Preserve ALL temporal information (e.g., "added on 2023-01-15", "last updated")
8. Remove conversational fluff, greetings, explanations, and filler text
9. Keep only factual data in a concise structured format

Special Attention To:
- Pokemon data: name, ID, type(s), abilities, stats, moves, evolution
- Move data: name, type, power, accuracy, PP, damage class, learning method
- Team data: team name, team ID, member count, member names and IDs
- Watchlist data: item names, IDs, count
- Ability data: name, effect, hidden/normal
- User actions: what was requested, what was completed

Format: Extract as bullet points or compact sentences.

Examples:

Input: "Great! I found Pikachu for you. Pikachu is an Electric-type Pokémon with ID 25. It has the abilities Static and Lightning Rod. It can learn 125 moves including Thunderbolt, Quick Attack, and Thunder Shock. Would you like to know more about any of these moves?"

Output: "Pikachu (ID: 25), Electric-type, Abilities: Static, Lightning Rod, Can learn 125 moves: Thunderbolt, Quick Attack, Thunder Shock"

Input: "I've checked your watchlist. You currently have 3 Pokémon in your watchlist: Charizard (ID: 6), Mewtwo (ID: 150), and Dragonite (ID: 149). They were added on different dates. Is there anything you'd like to do with these?"

Output: "Watchlist: 3 Pokémon - Charizard (ID: 6), Mewtwo (ID: 150), Dragonite (ID: 149)"

Input: "Your team 'Elite Squad' (ID: 42) has 6 members: Pikachu, Charizard, Blastoise, Venusaur, Gengar, Dragonite. The team was created on 2024-01-15 and last updated on 2024-06-20."

Output: "Team 'Elite Squad' (ID: 42): 6 members - Pikachu, Charizard, Blastoise, Venusaur, Gengar, Dragonite. Created: 2024-01-15, Updated: 2024-06-20"

Input: "add pikachu to my team"
Output: "add pikachu to my team" (keep short messages as-is)

Now summarize this message:`,
        },
        {
          role: 'user',
          content: message.content,
        },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    });
    if (summarized && summarized.length < message.content.length) {
      console.log(`📝 Summarized message: ${message.content.length} → ${summarized.length} chars (${Math.round((1 - summarized.length / message.content.length) * 100)}% reduction)`);
      return { ...message, content: summarized };
    }
  } catch (error) {
    console.warn('Message summarization failed:', error);
  }
  return message;
}

/**
 * Filters plan-related messages (plan proposals, approvals, clarification requests)
 * from the conversation history, keeping only user intentions and final results.
 */
export function filterPlanMessages(messages: Message[]): Message[] {
  return messages.filter((message) => {
    const content = message.content.toLowerCase();

    if (message.role === 'assistant' && (
      content.includes('What You\'re About To Do') ||
      content.includes('execution_plan') ||
      content.includes('needs_clarification') ||
      content.includes('"phase":') ||
      content.includes('would you like me to') ||
      content.includes('here\'s the plan') ||
      content.includes('i\'ll now') ||
      content.includes('approval needed') ||
      content.includes('do you approve')
    )) {
      console.log('⏭️ Filtering out plan proposal from assistant');
      return false;
    }

    if (message.role === 'user' && (
      /^(approve|yes|no|reject|cancel|abort|proceed|ok|confirm|go ahead|deny|decline|disagree)$/i.test(content.trim()) ||
      /^(approve|yes|reject|no|cancel)[\s!.]*$/.test(content.trim()) ||
      /^(please )?(approve|reject|cancel|proceed)/.test(content.trim())
    )) {
      console.log('⏭️ Filtering out approval/rejection message from user');
      return false;
    }

    if (message.role === 'assistant' && (
      content.includes('could you clarify') ||
      content.includes('what do you mean') ||
      content.includes('i need clarification') ||
      content.includes('please clarify') ||
      content.includes('could you please provide') ||
      content.includes('i\'m not sure what you mean')
    )) {
      console.log('⏭️ Filtering out clarification request from assistant');
      return false;
    }

    return true;
  });
}

/**
 * Summarizes older messages in a conversation to reduce token usage.
 * Messages are summarized individually to preserve all critical data.
 * If fewer than 10 messages, returns them as-is.
 */
export async function summarizeMessages(messages: Message[], apiKey: string): Promise<Message[]> {
  if (messages.length <= 10) {
    return messages;
  }

  const recentMessages = messages.slice(-5);
  const oldMessages = messages.slice(0, -5);

  console.log(`📊 Summarizing ${oldMessages.length} old messages, keeping ${recentMessages.length} recent messages intact`);

  try {
    const summarizedOldMessages = await Promise.all(
      oldMessages.map(msg => summarizeMessage(msg, apiKey))
    );

    return [
      ...summarizedOldMessages,
      ...recentMessages,
    ];
  } catch (error: any) {
    console.warn('Error summarizing messages:', error);
  }

  return recentMessages;
}

/**
 * Attempts to extract a key entity name from a refined query string.
 */
export function detectEntityName(refinedQuery: string): string | undefined {
  const text = refinedQuery || '';
  const quoted = text.match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];
  const verbNoun = text.match(/\b(?:add|remove|delete|drop|clear)\s+([A-Za-z0-9_-]+)/i);
  if (verbNoun) return verbNoun[1];
  const lastToken = text.trim().split(/\s+/).pop();
  return lastToken && lastToken.length > 1 ? lastToken : undefined;
}

/** Deep clones a value via JSON serialization. */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj || {}));
}

/** Recursively replaces all string occurrences of `search` with `replacement` in an object. */
export function replaceInObject(obj: any, search: string, replacement: string): void {
  if (typeof obj !== 'object' || obj === null) return;
  Object.keys(obj).forEach((key) => {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(new RegExp(search, 'gi'), replacement);
    } else if (typeof obj[key] === 'object') {
      replaceInObject(obj[key], search, replacement);
    }
  });
}
