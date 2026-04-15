/**
 * Shared API client for calling the HTTP API Gateway.
 * Uses Cognito ID tokens (JWT) for authentication instead of AWS SDK Lambda invocation.
 */

import { fetchAuthSession } from 'aws-amplify/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL;

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('Not authenticated - no ID token available');
  }
  return idToken;
}

/**
 * Make an authenticated API request to the HTTP API Gateway.
 *
 * @param path - API path (e.g. '/admin/trainees')
 * @param options - Request options (method, body, queryParams)
 * @returns Parsed JSON response
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    queryParams?: Record<string, string>;
  } = {}
): Promise<T> {
  const { method = 'GET', body, queryParams } = options;

  if (!API_BASE_URL) {
    throw new Error('API URL not configured. Set VITE_API_URL environment variable.');
  }

  const token = await getIdToken();

  let url = `${API_BASE_URL}${path}`;
  if (queryParams) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `API request failed: ${response.status}`);
  }

  return response.json();
}
