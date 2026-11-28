import { useState, useEffect, useRef } from 'react';
import { Users, Loader2, AlertCircle, Check, LogIn, UserPlus, ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { JoinLinkInfo } from '../types';

type AuthMode = 'choice' | 'login' | 'register';

interface JoinPageProps {
  token: string;
  onJoinComplete: () => void;
  onCancel: () => void;
  onNeedAuth?: (authType: 'login' | 'register') => void;
  authPage?: string;
  onAuthSuccess?: () => void;
}

export function JoinPage({ token, onJoinComplete, onCancel }: JoinPageProps) {
  const { isAuthenticated, isInitialized, user, login, register, checkAuth } = useAuth();
  const [linkInfo, setLinkInfo] = useState<JoinLinkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Auth form state
  const [authMode, setAuthMode] = useState<AuthMode>('choice');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [authLoading2, setAuthLoading2] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Track if we've already attempted to join to prevent duplicates (Issue #13)
  const hasAttemptedJoin = useRef(false);

  useEffect(() => {
    loadLinkInfo();
  }, [token]);

  // Auto-join after authentication
  useEffect(() => {
    // Prevent multiple join attempts (Issue #13)
    if (isAuthenticated && linkInfo && !success && !joining && !hasAttemptedJoin.current) {
      hasAttemptedJoin.current = true;
      handleJoin();
    }
  }, [isAuthenticated, linkInfo]);

  const loadLinkInfo = async () => {
    try {
      setLoading(true);
      setError(null);
      const info = await api.getJoinLinkInfo(token);
      setLinkInfo(info);
    } catch (err) {
      if (err instanceof Error && err.name === 'ApiError') {
        const apiError = err as ApiError;
        setError(apiError.details?.error as string || 'Invalid or expired invitation link');
      } else {
        setError('Failed to load invitation details');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!isAuthenticated) return;

    try {
      setJoining(true);
      setError(null);
      const invitation = await api.acceptInvitation(token);
      await checkAuth(invitation.organizationId);
      setSuccess(true);
      setTimeout(() => {
        onJoinComplete();
      }, 2000);
    } catch (err) {
      // Reset the flag so user can retry (Issue #13)
      hasAttemptedJoin.current = false;
      if (err instanceof Error && err.name === 'ApiError') {
        const apiError = err as ApiError;
        setError(apiError.details?.error as string || 'Failed to join league');
      } else {
        setError('Failed to join league');
      }
    } finally {
      setJoining(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setAuthLoading2(true);
      setAuthError(null);
      await login({ email, password });
      // After login, useEffect will auto-join
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setAuthLoading2(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setAuthLoading2(true);
      setAuthError(null);
      await register({ email, password, firstName, lastName });
      // After register, useEffect will auto-join
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setAuthLoading2(false);
    }
  };

  // Show loading state
  if (!isInitialized || loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-gray-500 dark:text-gray-400">Loading invitation...</p>
        </div>
      </div>
    );
  }

  // Show error state (no link info loaded)
  if (error && !linkInfo) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 text-center">
          <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Invalid Invitation
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            {error}
          </p>
          <button
            onClick={onCancel}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors mx-auto"
          >
            <ArrowLeft className="w-4 h-4" />
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  // Show success state
  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 text-center">
          <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Welcome to {linkInfo?.leagueName}!
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            You have successfully joined the league. Redirecting...
          </p>
        </div>
      </div>
    );
  }

  // Show joining state
  if (joining) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Joining {linkInfo?.leagueName}...
          </h1>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="w-8 h-8 text-blue-600 dark:text-blue-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            You're Invited!
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            {linkInfo?.invitedBy ? (
              <>
                <span className="font-medium">{linkInfo.invitedBy}</span> invited you to join{' '}
              </>
            ) : (
              <>Join </>
            )}
            <span className="font-semibold text-gray-900 dark:text-white">{linkInfo?.leagueName}</span>
            {linkInfo?.role && linkInfo.role !== 'viewer' && (
              <span className={`ml-1 ${linkInfo.role === 'admin' ? 'text-purple-600 dark:text-purple-400' : 'text-blue-600 dark:text-blue-400'}`}>
                (as {linkInfo.role})
              </span>
            )}
          </p>
        </div>

        {/* Error */}
        {(error || authError) && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
            <span className="text-sm text-red-700 dark:text-red-300">{error || authError}</span>
          </div>
        )}

        {/* Authenticated user - show join button */}
        {isAuthenticated && user && (
          <>
            <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg mb-6">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                Joining as:
              </p>
              <p className="font-medium text-gray-900 dark:text-white">
                {user.firstName || user.lastName
                  ? `${user.firstName} ${user.lastName}`.trim()
                  : user.email}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {user.email}
              </p>
            </div>
            <button
              onClick={handleJoin}
              disabled={joining}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <Users className="w-5 h-5" />
              Join League
            </button>
          </>
        )}

        {/* Not authenticated - show auth options */}
        {!isAuthenticated && (
          <>
            {authMode === 'choice' && (
              <div className="space-y-3">
                <p className="text-center text-gray-600 dark:text-gray-400 mb-4">
                  Sign in or create an account to join this league.
                </p>
                <button
                  onClick={() => setAuthMode('login')}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <LogIn className="w-5 h-5" />
                  Sign In
                </button>
                <button
                  onClick={() => setAuthMode('register')}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <UserPlus className="w-5 h-5" />
                  Create Account
                </button>
              </div>
            )}

            {authMode === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={authLoading2}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {authLoading2 ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <LogIn className="w-5 h-5" />
                  )}
                  Sign In & Join
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('choice');
                    setAuthError(null);
                  }}
                  className="w-full text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                >
                  Back to options
                </button>
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('register');
                      setAuthError(null);
                    }}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Create one
                  </button>
                </p>
              </form>
            )}

            {authMode === 'register' && (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      First Name
                    </label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Last Name
                    </label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                    required
                    minLength={8}
                  />
                  <p className="mt-1 text-xs text-gray-500">At least 8 characters</p>
                </div>
                <button
                  type="submit"
                  disabled={authLoading2}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {authLoading2 ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <UserPlus className="w-5 h-5" />
                  )}
                  Create Account & Join
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('choice');
                    setAuthError(null);
                  }}
                  className="w-full text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                >
                  Back to options
                </button>
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('login');
                      setAuthError(null);
                    }}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Sign in
                  </button>
                </p>
              </form>
            )}
          </>
        )}

        {/* Cancel button */}
        <button
          onClick={onCancel}
          className="w-full mt-4 px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
