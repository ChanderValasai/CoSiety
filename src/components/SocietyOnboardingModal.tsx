import React, { useState } from 'react';
import { Building2, X } from 'lucide-react';
import { apiFetch } from '../utils/api';

interface SocietyOnboardingModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (newSocietyId: string) => Promise<void>;
}

export const SocietyOnboardingModal: React.FC<SocietyOnboardingModalProps> = ({
  open,
  onClose,
  onCreated,
}) => {
  const [nameEn, setNameEn] = useState('');
  const [nameSd, setNameSd] = useState('');
  const [nameUr, setNameUr] = useState('');
  const [district, setDistrict] = useState('Tharparkar');
  const [foundingAdminName, setFoundingAdminName] = useState('Founding Portal Admin');
  const [levyAmountPkr, setLevyAmountPkr] = useState(50);
  const [levyCapPkr, setLevyCapPkr] = useState(100);
  const [termLengthMonths, setTermLengthMonths] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ society?: { id: string }; societyId?: string }>('/societies', {
        method: 'POST',
        body: JSON.stringify({
          nameEn,
          nameSd: nameSd || nameEn,
          nameUr: nameUr || nameEn,
          district,
          province: 'Sindh',
          levyAmountPkr,
          levyCapPkr,
          termLengthMonths,
          foundingAdminName: foundingAdminName || 'Founding Portal Admin',
        }),
      });
      const nextId = res.societyId || res.society?.id;
      if (nextId) {
        await onCreated(nextId);
      }
      setNameEn('');
      setNameSd('');
      setNameUr('');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#0F766E]" />
            <h2 className="text-lg font-bold text-slate-900">Onboard New Village Society</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            Pabohar launches first, and Cosiety provisions every new village with isolated ledgers, whole-village membership (zero neighbourhood/caste subdivisions), Vote-Points formula skeleton, and OD-01..OD-36 parameters.
          </p>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Village Name (English)</label>
              <input
                required
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                placeholder="e.g. Chachro"
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">District</label>
              <input
                required
                value={district}
                onChange={(e) => setDistrict(e.target.value)}
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Village Name (Sindhi)</label>
              <input
                dir="rtl"
                value={nameSd}
                onChange={(e) => setNameSd(e.target.value)}
                placeholder="چاڇرو"
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Village Name (Urdu)</label>
              <input
                dir="rtl"
                value={nameUr}
                onChange={(e) => setNameUr(e.target.value)}
                placeholder="چھاچھرو"
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Founding Portal Admin</label>
              <input
                required
                value={foundingAdminName}
                onChange={(e) => setFoundingAdminName(e.target.value)}
                className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Levy (Rs.)</label>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={levyAmountPkr}
                  onChange={(e) => setLevyAmountPkr(Number(e.target.value))}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-2 text-sm font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Cap (Rs.)</label>
                <input
                  type="number"
                  min={10}
                  max={500}
                  value={levyCapPkr}
                  onChange={(e) => setLevyCapPkr(Number(e.target.value))}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-2 text-sm font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Term (Mo)</label>
                <input
                  type="number"
                  min={6}
                  max={48}
                  value={termLengthMonths}
                  onChange={(e) => setTermLengthMonths(Number(e.target.value))}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-2 text-sm font-mono-num"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[42px] rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[42px] rounded-lg bg-[#0F766E] px-5 text-sm font-semibold text-white hover:bg-[#0D655E] cursor-pointer"
            >
              {busy ? 'Provisioning...' : 'Provision Village Society'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
