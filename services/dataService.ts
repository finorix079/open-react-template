export async function accessDatabase(token: string, query: string): Promise<any> {
  const baseUrl = process.env.NEXT_PUBLIC_ELASTICDASH_API || '';
  const url = `${baseUrl}/general/sql/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });


  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to fetch task list');
  }

  // Response shape: { success: true, result: { rows: [...], rowCount: N } }
  const data = await res.json();
  return data;
}

export async function runSelectQuery(query: string): Promise<any> {
  const startedAt = Date.now();
  console.log('[dataService] Running SQL query:', query);
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed.');
  }

  try {
    const data = await accessDatabase('', query);
    const durationMs = Date.now() - startedAt;
    const rows = data?.result?.rows ?? [];
    const rowCount = data?.result?.rowCount ?? rows.length;
    console.log(`[dataService] Query succeeded in ${durationMs}ms, rowCount=${rowCount}`);
    return rows;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error('[dataService] Query failed', {
      durationMs,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      code: (err as any)?.code,
      detail: (err as any)?.detail,
      hint: (err as any)?.hint,
    });
    throw err;
  }
}
