"use client";

import { useEffect, useState } from "react";

import { getLinearTickets, getRun } from "../lib/api";
import type { RunDetails, TicketSummary } from "../lib/types";

export function useTicketsQuery() {
  const [data, setData] = useState<TicketSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const tickets = await getLinearTickets();

        if (!isActive) {
          return;
        }

        setData(tickets);
      } catch (loadError) {
        if (!isActive) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Unknown ticket fetch failure");
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      isActive = false;
    };
  }, []);

  return { data, isLoading, error, setData };
}

export function useRunQuery(runId: string) {
  const [data, setData] = useState<RunDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const run = await getRun(runId);

        if (!isActive) {
          return;
        }

        setData(run);
      } catch (loadError) {
        if (!isActive) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Unknown run fetch failure");
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      isActive = false;
    };
  }, [runId]);

  return { data, isLoading, error, setData };
}
