const API = {
  async req(method, path, body) {
    const res = await fetch('/api' + path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  },
  get: p => API.req('GET', p),
  post: (p, b) => API.req('POST', p, b),
  put: (p, b) => API.req('PUT', p, b)
};
