/** POSTs JSON to one of our own endpoints and returns the body, turning `{error}` replies into Errors. */
export async function postForBlob(url: string, body: unknown, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `The request failed (${res.status}).`);
  }
  return res.blob();
}
