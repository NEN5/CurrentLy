const API = {
  async req(method, path, body) {
    const token = localStorage.getItem('token');
    const res = await fetch('/api' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !/^\/auth\//.test(path)) { localStorage.clear(); location.href = '/login.html'; }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  },
  get: p => API.req('GET', p),
  post: (p, b) => API.req('POST', p, b),
  put: (p, b) => API.req('PUT', p, b)
};