"use client";
import { useEffect, useMemo, useState } from "react";
import {
  environmentLabel,
  environmentQuery,
  inferCurrentEnvironmentSlug,
  nextEnvironmentSlug,
  type EnvironmentSlug,
} from "./environment-core";

export type { EnvironmentSlug };
export { environmentLabel, environmentQuery, inferCurrentEnvironmentSlug, nextEnvironmentSlug };

export function useCurrentEnvironment() {
  const [slug, setSlug] = useState<EnvironmentSlug>(() => inferCurrentEnvironmentSlug());

  useEffect(() => {
    setSlug(inferCurrentEnvironmentSlug());
  }, []);

  return useMemo(() => ({
    slug,
    label: environmentLabel(slug),
    nextSlug: nextEnvironmentSlug(slug),
    nextLabel: environmentLabel(nextEnvironmentSlug(slug)),
  }), [slug]);
}

