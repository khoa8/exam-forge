export function useParams<T extends Record<string, string>>(): T {
  const match = window.location.pathname.match(/^\/course\/([^/]+)/);
  return { id: match ? decodeURIComponent(match[1]) : "" } as unknown as T;
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function useRouter() {
  return { push: (path: string) => { window.location.assign(path); } };
}
