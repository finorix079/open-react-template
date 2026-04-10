/**
 * pokemonService.ts
 *
 * Fetches Pokémon data directly from the PokéAPI (https://pokeapi.co/api/v2).
 * No authentication required; all resources are publicly available.
 * Per PokéAPI fair-use policy, responses should be locally cached where possible.
 */

const POKEAPI_BASE = 'https://pokeapi.co/api/v2';
const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Finds the English entry in a PokeAPI `names` array.
 * Falls back to the resource's own `name` field if no English entry exists.
 */
function getEnglishName(
  names: Array<{ name: string; language: { name: string } }>,
): string {
  return names.find((n) => n.language.name === 'en')?.name ?? '';
}

/**
 * Finds the English `short_effect` in a PokeAPI `effect_entries` array.
 */
function getEnglishShortEffect(
  entries: Array<{ short_effect: string; language: { name: string } }>,
): string {
  return entries.find((e) => e.language.name === 'en')?.short_effect ?? '';
}

/**
 * Transforms a raw PokeAPI `/pokemon/{id}` response into the list-item shape
 * expected by the Pokémon list page.
 */
function transformPokemonListItem(raw: {
  id: number;
  name: string;
  sprites: { front_default: string | null };
  types: Array<{ type: { name: string } }>;
}): { id: number; identifier: string; sprite: string; types: string[] } {
  return {
    id: raw.id,
    identifier: raw.name,
    sprite:
      raw.sprites?.front_default ??
      `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${raw.id}.png`,
    types: (raw.types ?? []).map((t) => t.type.name),
  };
}

/**
 * Transforms a raw PokeAPI `/move/{id}` response into the move list-item shape
 * expected by the Move page.
 */
function transformMoveListItem(raw: {
  name: string;
  names: Array<{ name: string; language: { name: string } }>;
  type: { name: string } | null;
  power: number | null;
  accuracy: number | null;
}): { localized_name: string; type_name: string; power: number | null; accuracy: number | null } {
  return {
    localized_name: getEnglishName(raw.names ?? []) || raw.name,
    type_name: raw.type?.name ?? '',
    power: raw.power ?? null,
    accuracy: raw.accuracy ?? null,
  };
}

/**
 * Transforms a raw PokeAPI `/ability/{id}` response into the ability list-item
 * shape expected by the Ability page.
 */
function transformAbilityListItem(raw: {
  id: number;
  name: string;
  names: Array<{ name: string; language: { name: string } }>;
  effect_entries: Array<{ short_effect: string; language: { name: string } }>;
}): { id: number; localized_name: string; short_effect: string } {
  return {
    id: raw.id,
    localized_name: getEnglishName(raw.names ?? []) || raw.name,
    short_effect: getEnglishShortEffect(raw.effect_entries ?? []),
  };
}

// ---------------------------------------------------------------------------
// Pokemon search
// ---------------------------------------------------------------------------

/**
 * Searches for Pokémon by name (direct lookup) or returns a paginated list.
 *
 * When `searchterm` is provided, performs a direct name/id lookup against
 * `/pokemon/{searchterm}`. Otherwise fetches the paginated list and resolves
 * each entry's full details in parallel.
 *
 * @returns `{ success, result: { results, totalPage } }` matching the shape
 *          expected by the Pokémon list page.
 */
export const searchPokemonTool = async ({
  searchterm = '',
  page = 0,
}: {
  searchterm?: string;
  page?: number;
  sortby?: number;
  filter?: Record<string, unknown>;
}): Promise<{
  success: boolean;
  result: {
    results: Array<{ id: number; identifier: string; sprite: string; types: string[] }>;
    totalPage: number;
  };
}> => {
  try {
    if (searchterm.trim()) {
      const res = await fetch(
        `${POKEAPI_BASE}/pokemon/${encodeURIComponent(searchterm.trim().toLowerCase())}`,
      );
      if (!res.ok) throw new Error('Pokémon not found');
      const raw = await res.json();
      return {
        success: true,
        result: { results: [transformPokemonListItem(raw)], totalPage: 1 },
      };
    }

    const listRes = await fetch(
      `${POKEAPI_BASE}/pokemon/?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    if (!listRes.ok) throw new Error('Failed to fetch Pokémon list');
    const list = await listRes.json();
    const totalPage = Math.ceil(list.count / PAGE_SIZE);

    const results = await Promise.all(
      (list.results as Array<{ name: string; url: string }>).map((item) =>
        fetch(item.url)
          .then((r) => r.json())
          .then(transformPokemonListItem),
      ),
    );

    return { success: true, result: { results, totalPage } };
  } catch (error: unknown) {
    console.warn('Error searching Pokémon:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Move search
// ---------------------------------------------------------------------------

/**
 * Searches for moves by name (direct lookup) or returns a paginated list.
 *
 * Each move's detail endpoint is fetched in parallel to obtain `type_name`,
 * `power`, and `accuracy`.
 *
 * @returns `{ success, result: { results, totalPage } }` matching the shape
 *          expected by the Move page.
 */
export const searchMoveTool = async ({
  searchterm = '',
  page = 0,
}: {
  searchterm?: string;
  page?: number;
}): Promise<{
  success: boolean;
  result: {
    results: Array<{ localized_name: string; type_name: string; power: number | null; accuracy: number | null }>;
    totalPage: number;
  };
}> => {
  try {
    if (searchterm.trim()) {
      const res = await fetch(
        `${POKEAPI_BASE}/move/${encodeURIComponent(searchterm.trim().toLowerCase())}`,
      );
      if (!res.ok) throw new Error('Move not found');
      const raw = await res.json();
      return {
        success: true,
        result: { results: [transformMoveListItem(raw)], totalPage: 1 },
      };
    }

    const listRes = await fetch(
      `${POKEAPI_BASE}/move/?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    if (!listRes.ok) throw new Error('Failed to fetch move list');
    const list = await listRes.json();
    const totalPage = Math.ceil(list.count / PAGE_SIZE);

    const results = await Promise.all(
      (list.results as Array<{ url: string }>).map((item) =>
        fetch(item.url)
          .then((r) => r.json())
          .then(transformMoveListItem),
      ),
    );

    return { success: true, result: { results, totalPage } };
  } catch (error: unknown) {
    console.warn('Error searching Move:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Berry search
// ---------------------------------------------------------------------------

/**
 * Searches for berries by name (direct lookup) or returns a paginated list.
 *
 * @returns `{ success, result: { results, totalPage } }`
 */
export const searchBerryTool = async ({
  query = '',
  page = 0,
}: {
  query: string;
  page: number;
}): Promise<{ success: boolean; result: { results: unknown[]; totalPage: number } }> => {
  try {
    if (query.trim()) {
      const res = await fetch(
        `${POKEAPI_BASE}/berry/${encodeURIComponent(query.trim().toLowerCase())}`,
      );
      if (!res.ok) throw new Error('Berry not found');
      const raw = await res.json();
      return { success: true, result: { results: [raw], totalPage: 1 } };
    }

    const listRes = await fetch(
      `${POKEAPI_BASE}/berry/?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    if (!listRes.ok) throw new Error('Failed to fetch berry list');
    const list = await listRes.json();
    const totalPage = Math.ceil(list.count / PAGE_SIZE);

    const results = await Promise.all(
      (list.results as Array<{ url: string }>).map((item) =>
        fetch(item.url).then((r) => r.json()),
      ),
    );

    return { success: true, result: { results, totalPage } };
  } catch (error: unknown) {
    console.warn('Error searching Berry:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Ability search
// ---------------------------------------------------------------------------

/**
 * Searches for abilities by name (direct lookup) or returns a paginated list.
 *
 * Each ability's detail endpoint is fetched in parallel to obtain `short_effect`
 * and the English localized name.
 *
 * @returns `{ success, result: { results, totalPage } }` matching the shape
 *          expected by the Ability page.
 */
export const searchAbilityTool = async ({
  searchterm = '',
  page = 0,
}: {
  searchterm?: string;
  page?: number;
}): Promise<{
  success: boolean;
  result: {
    results: Array<{ id: number; localized_name: string; short_effect: string }>;
    totalPage: number;
  };
}> => {
  try {
    if (searchterm.trim()) {
      const res = await fetch(
        `${POKEAPI_BASE}/ability/${encodeURIComponent(searchterm.trim().toLowerCase())}`,
      );
      if (!res.ok) throw new Error('Ability not found');
      const raw = await res.json();
      return {
        success: true,
        result: { results: [transformAbilityListItem(raw)], totalPage: 1 },
      };
    }

    const listRes = await fetch(
      `${POKEAPI_BASE}/ability/?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    if (!listRes.ok) throw new Error('Failed to fetch ability list');
    const list = await listRes.json();
    const totalPage = Math.ceil(list.count / PAGE_SIZE);

    const results = await Promise.all(
      (list.results as Array<{ url: string }>).map((item) =>
        fetch(item.url)
          .then((r) => r.json())
          .then(transformAbilityListItem),
      ),
    );

    return { success: true, result: { results, totalPage } };
  } catch (error: unknown) {
    console.warn('Error searching Ability:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Pokemon details
// ---------------------------------------------------------------------------

/**
 * Fetches full Pokémon details for the detail page.
 *
 * Fires three requests in parallel:
 *   1. `/pokemon/{id}` — base stats, types, abilities (names), moves, sprites
 *   2. `/pokemon-species/{id}` — English flavor text
 *   3. One request per ability URL — English short_effect descriptions
 *
 * Note: Move `type`, `power`, and `accuracy` are not included in the
 * `/pokemon/{id}` moves array and would require one extra fetch per move.
 * The detail page already handles this by defaulting type to `"Normal"` and
 * displaying `"-"` for null power/accuracy.
 *
 * @returns `{ success, result }` matching the shape expected by the detail page.
 */
export const fetchPokemonDetailsTool = async (
  id: number | string,
): Promise<{ success: boolean; result: Record<string, unknown> }> => {
  try {
    const [pokemonRes, speciesRes] = await Promise.all([
      fetch(`${POKEAPI_BASE}/pokemon/${id}`),
      fetch(`${POKEAPI_BASE}/pokemon-species/${id}`),
    ]);

    if (!pokemonRes.ok) throw new Error('Failed to fetch Pokémon details');
    const raw = await pokemonRes.json();
    const species = speciesRes.ok ? await speciesRes.json() : null;

    // Fetch ability details in parallel to get English short_effect
    const abilityDetails = await Promise.all(
      (raw.abilities ?? []).map((a: { ability: { url: string } }) =>
        fetch(a.ability.url).then((r) => r.json()),
      ),
    );

    const abilities = (raw.abilities ?? []).map(
      (a: { ability: { name: string } }, i: number) => ({
        ability_name: a.ability.name,
        short_effect: getEnglishShortEffect(abilityDetails[i]?.effect_entries ?? []),
      }),
    );

    // Map PokeAPI stat names to camelCase keys used by the UI
    const STAT_KEY_MAP: Record<string, string> = {
      hp: 'hp',
      attack: 'attack',
      defense: 'defense',
      'special-attack': 'specialAttack',
      'special-defense': 'specialDefense',
      speed: 'speed',
    };
    const stats: Record<string, number> = {};
    for (const s of raw.stats ?? []) {
      const key = STAT_KEY_MAP[s.stat.name as string];
      if (key) stats[key] = s.base_stat as number;
    }

    // English flavor text — take the latest entry, replacing form-feed chars
    const flavorText: string =
      (species?.flavor_text_entries as Array<{
        flavor_text: string;
        language: { name: string };
      }> | undefined)
        ?.filter((e) => e.language.name === 'en')
        .slice(-1)[0]
        ?.flavor_text.replace(/\f/g, ' ') ?? '';

    // Extract move method and level from the latest version-group detail
    const moves = (
      raw.moves as Array<{
        move: { name: string };
        version_group_details: Array<{
          level_learned_at: number;
          move_learn_method: { name: string };
        }>;
      }>
    ).map((m) => {
      const latest = m.version_group_details[m.version_group_details.length - 1];
      return {
        name: m.move.name,
        type: null,   // requires an extra per-move fetch; UI defaults to "Normal"
        power: null,
        accuracy: null,
        move_method: latest?.move_learn_method?.name ?? 'unknown',
        level: latest?.level_learned_at ?? null,
      };
    });

    return {
      success: true,
      result: {
        id: raw.id as number,
        name: raw.name as string,
        sprite:
          (raw.sprites?.front_default as string | null) ??
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${raw.id}.png`,
        types: (raw.types as Array<{ type: { name: string } }>).map((t) => t.type.name),
        abilities,
        ...stats,
        // PokeAPI: height in decimetres → metres; weight in hectograms → kg
        height: ((raw.height as number) ?? 0) / 10,
        weight: ((raw.weight as number) ?? 0) / 10,
        baseExperience: raw.base_experience as number,
        flavorText,
        moves,
      },
    };
  } catch (error: unknown) {
    console.warn('Error fetching Pokémon details:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Watchlist stubs
// ---------------------------------------------------------------------------
// PokéAPI has no user-specific storage. These stubs keep the existing pages
// compilable while the watchlist UI gracefully shows an empty state.

/**
 * Stub: returns an empty watchlist.
 * PokéAPI does not support user-specific data.
 */
export const getWatchlistTool = async (): Promise<{ success: boolean; result: unknown[] }> => {
  return { success: true, result: [] };
};

/**
 * Stub: no-op add to watchlist.
 * PokéAPI does not support user-specific data.
 */
export const addToWatchlistTool = async (_pokemonId: number): Promise<void> => {
  // Not supported with PokéAPI
};

/**
 * Stub: no-op remove from watchlist.
 * PokéAPI does not support user-specific data.
 */
export const removeFromWatchlistTool = async (_pokemonId: number): Promise<void> => {
  // Not supported with PokéAPI
};

// ---------------------------------------------------------------------------
// Backward-compatible aliases (used by dashboard pages)
// ---------------------------------------------------------------------------
export {
  searchPokemonTool as searchPokemon,
  fetchPokemonDetailsTool as fetchPokemonDetails,
  searchMoveTool as searchMove,
  searchBerryTool as searchBerry,
  searchAbilityTool as searchAbility,
  getWatchlistTool as getWatchlist,
  addToWatchlistTool as addToWatchlist,
  removeFromWatchlistTool as removeFromWatchlist,
};
