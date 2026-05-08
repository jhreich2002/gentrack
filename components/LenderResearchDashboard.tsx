import React, { useState } from 'react';
import ToValidateTab from './lender-validation/ToValidateTab';
import ValidatedTab from './lender-validation/ValidatedTab';

type SubTab = 'to_validate' | 'validated';

interface Props {
  userRole: 'admin' | 'analyst' | 'viewer';
}

const TABS: { id: SubTab; label: string; description: string }[] = [
  { id: 'to_validate', label: 'To Validate',       description: 'Lenders with candidate plant evidence awaiting human review' },
  { id: 'validated',   label: 'Validated Lenders', description: 'Confirmed lender → plant portfolios; tier HOT / WARM / COLD' },
];

const LenderResearchDashboard: React.FC<Props> = ({ userRole: _userRole }) => {
  const [tab, setTab] = useState<SubTab>('to_validate');
  const [refreshKey, setRefreshKey] = useState(0);

  const visibleTabs = TABS;
  const active = visibleTabs.find(t => t.id === tab) ?? visibleTabs[0];

  const triggerRefresh = () => setRefreshKey(k => k + 1);

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="px-6 pt-5 pb-0 border-b border-slate-800 bg-slate-900/30 flex-shrink-0">
        <div className="flex items-end justify-between gap-4 mb-3">
          <div>
            <h1 className="text-xl font-bold text-white">Lender Research</h1>
            <p className="text-xs text-slate-400 mt-0.5">{active.description}</p>
          </div>
        </div>
        <nav className="flex gap-1">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'to_validate' && (
          <ToValidateTab refreshKey={refreshKey} onRefresh={triggerRefresh} />
        )}
        {tab === 'validated' && (
          <ValidatedTab refreshKey={refreshKey} onRefresh={triggerRefresh} />
        )}
      </div>
    </div>
  );
};

export default LenderResearchDashboard;
