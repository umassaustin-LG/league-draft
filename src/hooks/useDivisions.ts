import { useState, useEffect, useCallback } from 'react';
import {
  Division,
  DivisionSummary,
  DivisionPreset,
  DivisionAgeRange,
  DivisionMode,
} from '../types';
import { api, ApiError } from '../api/client';
import { saveTeamsToApi, savePlayersToApi } from '../api';
import { divisionNameExistsInWorkspace, hasGeneratedRosters } from '../utils/divisionAccess';

// Validation: A division is complete enough to persist when it has players
export function isDivisionValid(division: Division | null): boolean {
  if (!division) return false;
  return (
    division.name?.trim().length > 0 &&
    division.teamCount > 0 &&
    division.players?.length > 0
  );
}

// Check if division has minimum setup (name and teams) but no players yet
export function isDivisionPartiallySetup(division: Division | null): boolean {
  if (!division) return false;
  return (
    division.name?.trim().length > 0 &&
    division.teamCount > 0 &&
    (!division.players || division.players.length === 0)
  );
}

export function useDivisions(userId?: string, organizationId?: string | null) {
  const [, setDivisionIds] = useState<string[]>([]);
  const [loadedSummaries, setSummaries] = useState<DivisionSummary[]>([]);
  const [selectedDivision, setActiveDivision] = useState<Division | null>(null);
  const [loadedWorkspace, setLoadedWorkspace] = useState({ userId, organizationId });
  const isCurrentWorkspace = loadedWorkspace.userId === userId && loadedWorkspace.organizationId === organizationId;
  const summaries = isCurrentWorkspace ? loadedSummaries : [];
  const activeDivision = isCurrentWorkspace ? selectedDivision : null;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch only with an authenticated session and discard the previous account's data.
  useEffect(() => {
    let cancelled = false;
    setLoadedWorkspace({ userId, organizationId });
    setActiveDivision(null);
    setSummaries([]);
    setDivisionIds([]);
    setError(null);
    if (!userId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    api.listDivisions()
      .then((data) => {
        if (cancelled) return;
        setSummaries(data);
        setDivisionIds(data.map(d => d.id));
        setError(null);
      })
      .catch((err: ApiError) => {
        if (cancelled) return;
        console.error('Failed to load divisions from API:', err);
        setError('Failed to load divisions');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId, organizationId]);

  // Check if a division name already exists (case-insensitive)
  // Only check divisions that have players - empty ones will be cleaned up by the backend
  const divisionNameExists = useCallback((name: string): boolean => {
    return divisionNameExistsInWorkspace(loadedSummaries, name, organizationId);
  }, [loadedSummaries, organizationId]);

  // Create a new division
  const createDivision = useCallback(async (config: {
    name: string;
    preset: DivisionPreset;
    mode?: DivisionMode;
    teamCount: number;
    ageRange: DivisionAgeRange;
    enforceAgeLimit: boolean;
    maxPerAge: number;
    coaches?: Array<{ headCoach: string; assistantCoach: string }>;
  }): Promise<Division | null> => {
    // Check for duplicate name
    if (divisionNameExists(config.name)) {
      return null;
    }

    try {
      setIsLoading(true);
      const division = await api.createDivision({
        name: config.name,
        preset: config.preset,
        mode: config.mode,
        ageRange: config.ageRange,
        teamCount: config.teamCount,
        enforceAgeLimit: config.enforceAgeLimit,
        maxPerAge: config.maxPerAge,
        coaches: config.coaches,
      });

      // Add to summaries
      setSummaries(prev => [...prev, {
        id: division.id,
        name: division.name,
        preset: division.preset,
        mode: division.mode,
        teamCount: division.teamCount,
        playerCount: division.players.length,
        hasGeneratedRosters: hasGeneratedRosters(division),
        phase: division.phase,
        createdAt: division.createdAt,
        completedAt: division.completedAt,
        organizationId: division.organizationId,
        ownerId: division.ownerId,
        isPersonal: division.isPersonal,
      }]);
      setDivisionIds(prev => [...prev, division.id]);
      setActiveDivision(division);
      setError(null);
      return division;
    } catch (err) {
      console.error('Failed to create division:', err);
      setError('Failed to create division');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [divisionNameExists]);

  // Select an existing division
  const selectDivision = useCallback(async (divisionId: string): Promise<Division | null> => {
    try {
      setIsLoading(true);
      const division = await api.getDivision(divisionId);
      setActiveDivision(division);
      setError(null);
      return division;
    } catch (err: unknown) {
      console.error('Failed to load division:', err);
      // If division not found (404), remove it from the summaries list
      if (err instanceof ApiError && err.message.includes('Not Found')) {
        setSummaries(prev => prev.filter(s => s.id !== divisionId));
        setDivisionIds(prev => prev.filter(id => id !== divisionId));
        setError('Division not found - it may have been deleted');
      } else {
        setError('Failed to load division');
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Update the active division
  // Returns a Promise that resolves when the update is complete (Issue #6, #10)
  const updateActiveDivision = useCallback(async (updates: Partial<Division>): Promise<void> => {
    if (!activeDivision) return;

    const updated: Division = { ...activeDivision, ...updates };

    try {
      // Only send API-supported fields
      const apiUpdates: Parameters<typeof api.updateDivision>[1] = {};
      if (updates.name !== undefined) apiUpdates.name = updates.name;
      if (updates.preset !== undefined) apiUpdates.preset = updates.preset;
      if (updates.ageRange !== undefined) apiUpdates.ageRange = updates.ageRange;
      if (updates.enforceAgeLimit !== undefined) apiUpdates.enforceAgeLimit = updates.enforceAgeLimit;
      if (updates.maxPerAge !== undefined) apiUpdates.maxPerAge = updates.maxPerAge;
      if (updates.teamCount !== undefined) apiUpdates.teamCount = updates.teamCount;
      if (updates.rosterSize !== undefined) apiUpdates.rosterSize = updates.rosterSize;
      if (updates.scoringWeights !== undefined) apiUpdates.scoringWeights = updates.scoringWeights;
      if (updates.teamBuilderSettings !== undefined) apiUpdates.teamBuilderSettings = updates.teamBuilderSettings;
      if (updates.scoringMode !== undefined) apiUpdates.scoringMode = updates.scoringMode;
      if (updates.phase !== undefined) apiUpdates.phase = updates.phase;

      // Only call API if there are API-supported updates
      if (Object.keys(apiUpdates).length > 0) {
        const division = await api.updateDivision(activeDivision.id, apiUpdates);
        setActiveDivision(division);

        // Update summary
        setSummaries(prev => prev.map(s =>
          s.id === division.id ? {
            id: division.id,
            name: division.name,
            preset: division.preset,
            mode: division.mode,
            teamCount: division.teamCount,
            playerCount: division.players.length,
            hasGeneratedRosters: hasGeneratedRosters(division),
            phase: division.phase,
            createdAt: division.createdAt,
            completedAt: division.completedAt,
            organizationId: division.organizationId,
            ownerId: division.ownerId,
            isPersonal: division.isPersonal,
          } : s
        ));
      }

      // Save teams to API if they were updated
      if (updates.teams !== undefined) {
        const savedTeams = await saveTeamsToApi(activeDivision.id, updates.teams);
        // Update local state with the saved teams
        setActiveDivision(prev => prev ? { ...prev, teams: savedTeams } : prev);
      }

      // Save players to API if they were updated
      if (updates.players !== undefined) {
        const savedPlayers = await savePlayersToApi(activeDivision.id, updates.players);
        // Update local state with the saved players
        setActiveDivision(prev => prev ? { ...prev, players: savedPlayers } : prev);
      }

      // For other non-API updates, just update local state
      if (Object.keys(apiUpdates).length === 0 && updates.teams === undefined && updates.players === undefined) {
        setActiveDivision(updated);
      }
      setError(null);
    } catch (err) {
      console.error('Failed to update division:', err);
      setError('Failed to update division');
      throw err; // Re-throw so callers can handle (Issue #6)
    }
  }, [activeDivision]);

  // Delete a division
  const deleteDivision = useCallback(async (divisionId: string): Promise<void> => {
    try {
      setIsLoading(true);
      await api.deleteDivision(divisionId);
      setDivisionIds(prev => prev.filter(id => id !== divisionId));
      setSummaries(prev => prev.filter(s => s.id !== divisionId));
      if (activeDivision?.id === divisionId) {
        setActiveDivision(null);
      }
      setError(null);
    } catch (err) {
      console.error('Failed to delete division:', err);
      setError('Failed to delete division');
    } finally {
      setIsLoading(false);
    }
  }, [activeDivision]);

  // Clear active division (return to selector)
  const clearActiveDivision = useCallback((): void => {
    setActiveDivision(null);
  }, []);

  // Refresh summaries from API
  const refreshSummaries = useCallback(async (): Promise<void> => {
    try {
      setIsLoading(true);
      const data = await api.listDivisions();
      setSummaries(data);
      setDivisionIds(data.map(d => d.id));
      setError(null);
    } catch (err) {
      console.error('Failed to refresh divisions:', err);
      setError('Failed to refresh divisions');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Refresh active division from API
  const refreshActiveDivision = useCallback(async (): Promise<void> => {
    if (!activeDivision) return;

    try {
      const division = await api.getDivision(activeDivision.id);
      setActiveDivision(division);
      setError(null);
    } catch (err) {
      console.error('Failed to refresh active division:', err);
      setError('Failed to refresh division');
    }
  }, [activeDivision]);

  // Full refresh - both summaries and active division
  const refreshDivisions = useCallback(async (): Promise<void> => {
    await refreshSummaries();
    if (activeDivision) {
      try {
        const division = await api.getDivision(activeDivision.id);
        setActiveDivision(division);
      } catch (err) {
        console.error('Failed to refresh active division:', err);
      }
    }
  }, [activeDivision, refreshSummaries]);

  return {
    summaries,
    activeDivision,
    createDivision,
    selectDivision,
    updateActiveDivision,
    deleteDivision,
    clearActiveDivision,
    refreshSummaries,
    refreshActiveDivision,
    refreshDivisions,
    divisionNameExists,
    isLoading,
    error,
  };
}
