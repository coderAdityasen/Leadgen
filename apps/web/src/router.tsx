import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface RouterState {
  path: string;
  /** `replace`: swap the current history entry (redirects) instead of adding one. */
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterState>({
  path: window.location.pathname,
  navigate: () => {},
});

export function useRouter() {
  return useContext(RouterContext);
}

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // `path` holds only the pathname; any ?query in `to` stays in window.location.search
  // so views can read it (e.g. /leads?new=1) without breaking route matching.
  const navigate = (to: string, options?: { replace?: boolean }) => {
    if (to !== window.location.pathname + window.location.search) {
      if (options?.replace) window.history.replaceState({}, "", to);
      else window.history.pushState({}, "", to);
      setPath(window.location.pathname);
    }
  };

  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export function Link({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const { navigate, path } = useRouter();
  const isActive = path === href;

  return (
    <a
      href={href}
      className={`${className ?? ""} ${isActive ? "active" : ""}`.trim()}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
