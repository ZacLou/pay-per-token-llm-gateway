// ... (existing imports and code)

class ApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Gateway error ${status}: ${body}`);
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // ... (existing code)

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }

  // ... (existing code)
}

export { ApiError };
// ... (rest of existing api.ts code)
