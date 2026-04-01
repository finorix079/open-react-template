/**
 * pokemonRagService.ts
 * Static PokéAPI tool catalog for RAG-based tool selection.
 *
 * Replaces the old embedding-based retrieval (OpenAI ada-002 embeddings + vectorized
 * ElasticDash schemas) with a simple keyword/tag matching approach.
 * No external API calls are needed — the catalog is defined statically.
 */

export interface PokemonTool {
  /** Unique tool identifier — matches the key in agentTools */
  id: string;
  /** Short human-readable description */
  summary: string;
  /** Keywords used for relevance scoring */
  tags: string[];
  /** Full tool description including parameters and example (passed to the planner LLM) */
  content: string;
  /** Relevance score computed by getMatchedPokemonTools() */
  similarity: number;
}

/** All available PokéAPI tools with their descriptions and keyword tags. */
const POKEAPI_TOOL_CATALOG: Omit<PokemonTool, 'similarity'>[] = [
  {
    id: 'searchPokemon',
    summary: 'Search Pokémon by name or list all Pokémon paginated',
    tags: ['pokemon', 'search', 'list', 'browse', 'find', 'show', 'all', 'pokedex'],
    content: `tool: searchPokemon
api: GET /pokemon
summary: Search for a Pokémon by name or browse all Pokémon paginated.
parameters:
  - name (string, optional): Pokémon name (e.g. "pikachu"). Omit to list all.
  - page (number, optional): Page number for pagination (default 1).
returns: { results: [{ id, name, sprite, types }], totalPage }
example: GET /pokemon?name=pikachu`,
  },
  {
    id: 'fetchPokemonDetails',
    summary: 'Fetch complete Pokémon details: stats, moves, abilities, types, species',
    tags: ['pokemon', 'details', 'stats', 'moves', 'abilities', 'types', 'species',
           'hp', 'attack', 'defense', 'speed', 'height', 'weight', 'flavor', 'info'],
    content: `tool: fetchPokemonDetails
api: GET /pokemon/{idOrName}
summary: Get full details for a single Pokémon by ID or name.
parameters:
  - idOrName (number|string, required): Pokémon ID number or lowercase name (e.g. 25 or "pikachu").
returns: { id, name, types, stats{ hp, attack, defense, specialAttack, specialDefense, speed }, abilities, moves, height, weight, flavorText }
example: GET /pokemon/pikachu`,
  },
  {
    id: 'searchMove',
    summary: 'Search moves by name or list all moves',
    tags: ['move', 'attack', 'skill', 'power', 'accuracy', 'pp', 'type', 'damage', 'technique', 'learnset'],
    content: `tool: searchMove
api: GET /move
summary: Search for a move by name or browse all moves paginated.
parameters:
  - name (string, optional): Move name in lowercase-hyphen format (e.g. "thunderbolt", "fire-blast"). Omit to list all.
  - page (number, optional): Page number.
returns: { results: [{ id, name, type, power, accuracy, pp }], totalPage }
example: GET /move?name=thunderbolt`,
  },
  {
    id: 'searchAbility',
    summary: 'Search Pokémon abilities by name or list all abilities',
    tags: ['ability', 'passive', 'trait', 'effect', 'hidden', 'characteristic', 'skill', 'special'],
    content: `tool: searchAbility
api: GET /ability
summary: Search for an ability by name or browse all abilities paginated.
parameters:
  - name (string, optional): Ability name (e.g. "levitate", "lightning-rod"). Omit to list all.
  - page (number, optional): Page number.
returns: { results: [{ id, name, shortEffect }], totalPage }
example: GET /ability?name=levitate`,
  },
  {
    id: 'searchBerry',
    summary: 'Search berries by name or list all berries',
    tags: ['berry', 'item', 'held', 'natural-gift', 'growth', 'fruit'],
    content: `tool: searchBerry
api: GET /berry
summary: Search for a berry by name or browse all berries paginated.
parameters:
  - name (string, optional): Berry name (e.g. "cheri", "sitrus"). Omit to list all.
  - page (number, optional): Page number.
returns: { results: [{ id, name, growth_time, natural_gift_power, natural_gift_type, size, smoothness }] }
example: GET /berry?name=cheri`,
  },
];

/**
 * Returns all PokéAPI tools ranked by keyword relevance to the given entities.
 * Uses tag and summary matching — no OpenAI embedding calls required.
 *
 * @param entities - User-extracted entity strings (e.g. ["pikachu", "stats"])
 * @returns Sorted array of tools with similarity scores (highest first)
 */
export function getMatchedPokemonTools(entities: string[]): PokemonTool[] {
  const entityText = entities.join(' ').toLowerCase();
  const firstWord = entityText.split(/\s+/)[0] || '';

  return POKEAPI_TOOL_CATALOG
    .map((tool) => {
      let score = 0.5; // base relevance — all tools are potentially useful

      for (const tag of tool.tags) {
        if (entityText.includes(tag) || tag.includes(firstWord)) {
          score += 0.08;
        }
      }

      if (firstWord && tool.summary.toLowerCase().includes(firstWord)) {
        score += 0.2;
      }

      return { ...tool, similarity: Math.min(score, 1.0) };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Returns all PokéAPI tools as a Map keyed by tool id.
 * Convenience wrapper for callers that expect the Map<string, PokemonTool> shape.
 */
export function getAllPokemonToolsMap(entities: string[]): Map<string, PokemonTool> {
  const tools = getMatchedPokemonTools(entities);
  const map = new Map<string, PokemonTool>();
  for (const tool of tools) {
    map.set(tool.id, tool);
  }
  return map;
}
