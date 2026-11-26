import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api, ApiError, setSessionExpiredCallback } from '../api/client';
import type { User, LoginCredentials, RegisterData } from '../types';
import { selectActiveOrganization } from '../api/activeOrganization';
import { canSelectPersonalWorkspace } from '../utils/divisionAccess';

interface AuthState {
  activeOrganizationId: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
}

interface AuthContextType extends AuthState {
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: (preferredOrganizationId?: string) => Promise<void>;
  switchOrganization: (organizationId: string) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>({
    activeOrganizationId: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    isInitialized: false,
  });

  // Track if we've already handled session expiry to avoid loops (Issue #4)
  const sessionExpiredHandled = useRef(false);

  const checkAuth = useCallback(async (preferredOrganizationId?: string) => {
    try {
      const user = await api.getCurrentUser();
      const activeOrganizationId = selectActiveOrganization(user, preferredOrganizationId);
      setState(prev => ({
        ...prev,
        user,
        activeOrganizationId,
        isAuthenticated: true,
        isLoading: false,
      }));
    } catch (error) {
      selectActiveOrganization(null);
      // Not authenticated or error - clear state
      setState(prev => ({
        ...prev,
        user: null,
        activeOrganizationId: null,
        isAuthenticated: false,
        isLoading: false,
      }));
    }
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    // Reset session expired flag on new login attempt (Issue #21)
    sessionExpiredHandled.current = false;
    setState(prev => ({ ...prev, isLoading: true }));
    try {
      const user = await api.login(credentials);
      const activeOrganizationId = selectActiveOrganization(user);
      setState(prev => ({
        ...prev,
        user,
        activeOrganizationId,
        isAuthenticated: true,
        isLoading: false,
      }));
    } catch (error) {
      setState(prev => ({ ...prev, isLoading: false }));
      // Handle ApiError (check by name since instanceof can fail across module boundaries)
      if (error instanceof Error && error.name === 'ApiError') {
        const apiError = error as ApiError;
        throw new Error(apiError.details?.error as string || 'Login failed');
      }
      throw error;
    }
  }, []);

  const register = useCallback(async (data: RegisterData) => {
    setState(prev => ({ ...prev, isLoading: true }));
    try {
      const user = await api.register(data);
      const activeOrganizationId = selectActiveOrganization(user);
      setState(prev => ({
        ...prev,
        user,
        activeOrganizationId,
        isAuthenticated: true,
        isLoading: false,
      }));
    } catch (error) {
      setState(prev => ({ ...prev, isLoading: false }));
      // Handle ApiError (check by name since instanceof can fail across module boundaries)
      if (error instanceof Error && error.name === 'ApiError') {
        const apiError = error as ApiError;
        const details = apiError.details;
        // Handle validation errors
        if (details?.email) {
          throw new Error((details.email as string[])[0]);
        }
        if (details?.password) {
          throw new Error((details.password as string[])[0]);
        }
        if (details?.error) {
          throw new Error(details.error as string);
        }
        throw new Error('Registration failed');
      }
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Ignore errors on logout
    }
    // Clear session expired flag (Issue #22)
    sessionExpiredHandled.current = false;
    selectActiveOrganization(null);
    setState(prev => ({
      ...prev,
      user: null,
      activeOrganizationId: null,
      isAuthenticated: false,
      isLoading: false,
    }));
    // Notify other tabs about logout (Issue #27 - cross-tab sync)
    localStorage.setItem('logout-event', Date.now().toString());
    // Note: Draft state is stored in useDraft hook which is re-initialized on re-mount
    // after logout/login cycle. No explicit cleanup needed here.
  }, []);

  // Initialize CSRF token and check authentication on mount
  useEffect(() => {
    const init = async () => {
      // Initialize CSRF token first
      await api.initCSRF();
      // Then check authentication
      await checkAuth();
      setState(prev => ({ ...prev, isInitialized: true }));
    };
    init();

    // Register session expiry callback (Issue #4)
    setSessionExpiredCallback(() => {
      if (!sessionExpiredHandled.current) {
        sessionExpiredHandled.current = true;
        console.log('Session expired, logging out user');
        selectActiveOrganization(null);
        // Clear state immediately without calling API (session is already invalid)
        setState(prev => ({
          ...prev,
          user: null,
          activeOrganizationId: null,
          isAuthenticated: false,
          isLoading: false,
        }));
        // Notify other tabs about logout (Issue #27 - cross-tab sync)
        localStorage.setItem('logout-event', Date.now().toString());
      }
    });

    // Cleanup callback on unmount
    return () => {
      setSessionExpiredCallback(null);
    };
  }, [checkAuth]);

  // Cross-tab logout synchronization (Issue #27)
  // When user logs out in one tab, all other tabs should also log out
  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      // Check for logout event from another tab
      if (event.key === 'logout-event' && event.newValue) {
        console.log('Logout detected from another tab, clearing auth state');
        // Only clear state if we're currently authenticated
        if (state.isAuthenticated && !sessionExpiredHandled.current) {
          sessionExpiredHandled.current = true;
          selectActiveOrganization(null);
          setState(prev => ({
            ...prev,
            user: null,
            activeOrganizationId: null,
            isAuthenticated: false,
            isLoading: false,
          }));
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [state.isAuthenticated]);

  const switchOrganization = useCallback((organizationId: string) => {
    if (!state.user || !(organizationId === '' && canSelectPersonalWorkspace(state.user))
      && !state.user.organizations.some(m => m.organizationId === organizationId)) return;
    const activeOrganizationId = selectActiveOrganization(state.user, organizationId);
    setState(prev => ({ ...prev, activeOrganizationId }));
  }, [state.user]);

  const value: AuthContextType = {
    ...state,
    login,
    register,
    logout,
    checkAuth,
    switchOrganization,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
