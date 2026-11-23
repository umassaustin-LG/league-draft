import { useState } from 'react';
import { ArrowLeft, Users, Settings } from 'lucide-react';
import { User as UserType, LeagueMembership } from '../../types';
import { MembersTab } from './MembersTab';
import { ProfileTab } from './ProfileTab';

type TabType = 'members' | 'profile';

interface ProfilePageProps {
  user: UserType;
  onBack: () => void;
  onUserUpdate: (user: UserType) => void;
}

export function ProfilePage({ user, onBack, onUserUpdate }: ProfilePageProps) {
  const [activeTab, setActiveTab] = useState<TabType>('members');
  const [selectedLeague, setSelectedLeague] = useState<LeagueMembership | null>(
    user.leagues.length > 0 ? user.leagues[0] : null
  );

  // Check if user is admin of selected league
  const isAdmin = selectedLeague?.role === 'admin';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
                Settings
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {isAdmin ? 'Manage your account and league settings' : 'Manage your profile and view league members'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* League Selector (if user has multiple leagues) */}
        {user.leagues.length > 1 && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Select League
            </label>
            <select
              value={selectedLeague?.leagueId || ''}
              onChange={(e) => {
                const league = user.leagues.find(l => l.leagueId === e.target.value);
                setSelectedLeague(league || null);
              }}
              className="w-full max-w-xs px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
            >
              {user.leagues.map((league) => (
                <option key={league.leagueId} value={league.leagueId}>
                  {league.leagueName} ({league.role})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setActiveTab('members')}
            className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'members'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            <Users className="w-4 h-4" />
            Members
          </button>
          <button
            onClick={() => setActiveTab('profile')}
            className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'profile'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            <Settings className="w-4 h-4" />
            My Profile
          </button>
        </div>

        {/* Tab Content */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          {activeTab === 'members' && selectedLeague && (
            <MembersTab
              leagueId={selectedLeague.leagueId}
              leagueName={selectedLeague.leagueName}
              isAdmin={isAdmin}
              currentUserId={user.id}
            />
          )}
          {activeTab === 'members' && !selectedLeague && (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              You are not a member of any league.
            </div>
          )}
          {activeTab === 'profile' && (
            <ProfileTab user={user} onUserUpdate={onUserUpdate} />
          )}
        </div>
      </div>
    </div>
  );
}
