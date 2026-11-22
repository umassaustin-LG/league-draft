import { useState } from 'react';
import { Plus, Play, Eye, Trash2, Calendar, Users, AlertCircle, LogOut, User, Settings, ClipboardList } from 'lucide-react';
import { DivisionSummary, AppPhase, User as UserType } from '../types';
import { canManageDivision, getDivisionView } from '../utils/divisionAccess';

interface DivisionSelectorProps {
  divisions: DivisionSummary[];
  onSelectDivision: (divisionId: string) => void;
  onCreateNew?: () => void;
  onDeleteDivision?: (divisionId: string) => void;
  creationLeagueName?: string;
  user?: UserType | null;
  onLogout?: () => void;
  onOpenSettings?: () => void;
  onOpenTemplates?: () => void;
}

function getPhaseLabel(phase: AppPhase): string {
  switch (phase) {
    case 'upload': return 'Not Started';
    case 'mapping': return 'Mapping Columns';
    case 'review': return 'Reviewing Players';
    case 'config': return 'Configuring Draft';
    case 'draft': return 'Draft In Progress';
    case 'complete': return 'Completed';
    default: return phase;
  }
}

function getPhaseColor(phase: AppPhase): string {
  switch (phase) {
    case 'upload': return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
    case 'mapping':
    case 'review':
    case 'config': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
    case 'draft': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    case 'complete': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    default: return 'bg-gray-100 text-gray-700';
  }
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const DivisionSelector = ({
  divisions,
  onSelectDivision,
  onCreateNew,
  onDeleteDivision,
  creationLeagueName,
  user,
  onLogout,
  onOpenSettings,
  onOpenTemplates,
}: DivisionSelectorProps) => {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleDelete = (divisionId: string) => {
    if (deleteConfirm === divisionId) {
      onDeleteDivision?.(divisionId);
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(divisionId);
    }
  };

  // Show all divisions - they persist as soon as they're created
  const sortedDivisions = [...divisions].sort((a, b) => {
    // In-progress first, then by creation date (newest first)
    if (a.phase === 'complete' && b.phase !== 'complete') return 1;
    if (a.phase !== 'complete' && b.phase === 'complete') return -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }).map(division => ({
    division,
    canManage: !!onDeleteDivision && canManageDivision(user ?? null, division),
    view: getDivisionView(division),
    workspace: user?.organizations.find(m => m.organizationId === division.organizationId),
  }));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="max-w-3xl w-full">
        {/* User Header */}
        {user && onLogout && (
          <div className="flex items-center justify-end gap-4 mb-4 px-1">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <User className="w-4 h-4" />
              <span>{user.email}</span>
              {user.leagues.length > 0 && (
                <span className="text-gray-400 dark:text-gray-500">
                  ({user.leagues.map(l => l.leagueName).join(', ')})
                </span>
              )}
            </div>
            {onOpenTemplates && (
              <button
                onClick={onOpenTemplates}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md transition-colors"
              >
                <ClipboardList className="w-4 h-4" />
                Evaluation Setup
              </button>
            )}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md transition-colors"
              >
                <Settings className="w-4 h-4" />
                Settings
              </button>
            )}
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>
        )}

        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Little League Draft
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Select a division to continue
          </p>
        </div>

        {/* Create New Division Button */}
        {onCreateNew && <button
          onClick={onCreateNew}
          className="w-full mb-6 p-6 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors flex items-center justify-center gap-3 group"
        >
          <Plus className="w-8 h-8 text-gray-400 group-hover:text-blue-500 transition-colors" />
          <span className="text-left">
            <span className="block text-xl font-semibold text-gray-700 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              {creationLeagueName ? 'Create New Division' : 'Create Personal Division'}
            </span>
            <span className="block text-sm text-gray-600 dark:text-gray-400">
              {creationLeagueName ? `Shared with ${creationLeagueName}` : 'Not shared with a league'}
            </span>
          </span>
        </button>}

        {/* Division List */}
        {sortedDivisions.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 px-1">
              Existing Divisions
            </h2>

            {sortedDivisions.map(({ division, canManage, view, workspace }) => (
              <article
                key={division.id}
                aria-label={division.name}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white truncate">
                          {division.name}
                        </h3>
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${getPhaseColor(division.phase)}`}>
                          {getPhaseLabel(division.phase)}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
                        <span>
                          {workspace?.organizationName ?? (division.organizationId ? 'League division' : 'Personal division')}
                          {!canManage && ' · Read-only'}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Users className="w-4 h-4" />
                          {division.teamCount} teams
                          {division.playerCount > 0 && ` / ${division.playerCount} players`}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Calendar className="w-4 h-4" />
                          {division.completedAt
                            ? `Completed ${formatDate(division.completedAt)}`
                            : `Created ${formatDate(division.createdAt)}`}
                        </span>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-2 ml-4">
                      {!canManage || division.phase === 'complete' ? (
                        <button
                          onClick={() => onSelectDivision(division.id)}
                          className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                          {canManage ? 'View Results' : view === 'rosters' ? 'View Rosters' : view === 'draft' ? 'View Draft' : 'View Division'}
                        </button>
                      ) : (
                        <button
                          onClick={() => onSelectDivision(division.id)}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                          <Play className="w-4 h-4" />
                          {division.phase === 'upload' ? 'Start' : 'Resume'}
                        </button>
                      )}

                      {canManage && <button
                        onClick={() => handleDelete(division.id)}
                        className={`p-2 rounded-lg transition-colors ${
                          deleteConfirm === division.id
                            ? 'bg-red-600 text-white'
                            : 'text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
                        }`}
                        title={deleteConfirm === division.id ? 'Click again to confirm' : 'Delete division'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>}
                    </div>
                  </div>
                </div>

                {/* Delete Confirmation */}
                {canManage && deleteConfirm === division.id && (
                  <div className="px-5 pb-4">
                    <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                      <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                      <span className="text-sm text-red-700 dark:text-red-300">
                        Click delete again to permanently remove this division and all its data.
                      </span>
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="ml-auto text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        {/* Empty State */}
        {sortedDivisions.length === 0 && (
          <div className="text-center py-12">
            <div className="text-gray-400 dark:text-gray-600 mb-2">
              <Users className="w-16 h-16 mx-auto" />
            </div>
            <p className="text-gray-500 dark:text-gray-500">
              {onCreateNew ? 'No divisions yet. Create one to get started.' : 'No divisions to view yet.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
