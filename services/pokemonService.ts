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

function getEnglishName(
  names: Array<{ name: string; language: { name: string } }>,
): string {
  return names.find((n) => n.language.name === 'en')?.name ?? '';
}

function getEnglishShortEffect(
  entries: Array<{ short_effect: string; language: { name: string } }>,
): string {
  return entries.find((e) => e.language.name === 'en')?.short_effect ?? '';
}

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

export const searchPokemon = async ({
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

export const searchMove = async ({
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

export const searchBerry = async ({
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

export const searchAbility = async ({
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

export const fetchPokemonDetails = async (
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

    const flavorText: string =
      (species?.flavor_text_entries as Array<{
        flavor_text: string;
        language: { name: string };
      }> | undefined)
        ?.filter((e) => e.language.name === 'en')
        .slice(-1)[0]
        ?.flavor_text.replace(/\f/g, ' ') ?? '';

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
        type: null,
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
// Watchlist stubs — PokéAPI has no user-specific storage
// ---------------------------------------------------------------------------

export const getWatchlist = async (): Promise<{ success: boolean; result: unknown[] }> => {
  return { success: true, result: [] };
};

export const addToWatchlist = async (_pokemonId: number): Promise<void> => {
  // Not supported with PokéAPI
};

export const removeFromWatchlist = async (_pokemonId: number): Promise<void> => {
  // Not supported with PokéAPI
};
