import type { NextFunction, Request, Response } from 'express';
import { coreDb } from './db.ts';

export interface AuthMember {
  id: string;
  society_id: string;
  household_id: string;
  full_name: string;
  gender: string;
  date_of_birth: string;
  status: string;
  identity_status: string;
  voting_suspended_until: string | null;
  preferred_lang: string;
  roles: string[];
  team_side: 'woman' | 'man' | null;
}

declare global {
  namespace Express {
    interface Request {
      societyId: string;
      authMember: AuthMember | null;
    }
  }
}

export type AuthedRequest = Request<any, any, any, any>;

export function getMemberRoles(societyId: string, memberId: string): string[] {
  const now = new Date().toISOString();
  const rows = coreDb
    .prepare(
      `SELECT role_code FROM role_assignment
       WHERE society_id = ? AND member_id = ? AND valid_from <= ? AND valid_to > ?`
    )
    .all(societyId, memberId, now, now) as Array<{ role_code: string }>;
  return [...new Set(rows.map((r) => r.role_code))];
}

export function getMemberTeamSide(societyId: string, memberId: string): 'woman' | 'man' | null {
  const now = new Date().toISOString();
  const row = coreDb
    .prepare(
      `SELECT team_side FROM role_assignment
       WHERE society_id = ? AND member_id = ? AND valid_from <= ? AND valid_to > ? AND team_side IS NOT NULL
       LIMIT 1`
    )
    .get(societyId, memberId, now, now) as { team_side: 'woman' | 'man' } | undefined;
  return row?.team_side ?? null;
}

export function computeAge(dobIso: string): number {
  const dob = new Date(dobIso);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

export function isVerifiedAdultVoter(member: AuthMember, minAge = 18): boolean {
  if (member.status !== 'active' || member.identity_status !== 'approved') return false;
  if (member.voting_suspended_until && member.voting_suspended_until > new Date().toISOString()) {
    return false;
  }
  return computeAge(member.date_of_birth) >= minAge;
}

export function attachContext(req: Request, res: Response, next: NextFunction): void {
  const areq = req as AuthedRequest;
  const requestedSociety =
    (req.header('x-society-id') || (req.query.societyId as string) || 'pabohar').trim();

  const soc = coreDb
    .prepare('SELECT id FROM society WHERE id = ?')
    .get(requestedSociety) as { id: string } | undefined;

  if (!soc) {
    res.status(404).json({ code: 'SOCIETY_NOT_FOUND', title: 'Village society not found' });
    return;
  }

  areq.societyId = soc.id;
  areq.authMember = null;

  const sessionToken = req.header('x-session-token');
  if (sessionToken) {
    const sess = coreDb
      .prepare('SELECT member_id, society_id, expires_at FROM session_token WHERE token = ?')
      .get(sessionToken) as { member_id: string; society_id: string; expires_at: string } | undefined;

    if (sess && sess.expires_at > new Date().toISOString()) {
      const m = coreDb
        .prepare(
          `SELECT id, society_id, household_id, full_name, gender,
                  date_of_birth, status, identity_status, voting_suspended_until, preferred_lang
           FROM member WHERE id = ?`
        )
        .get(sess.member_id) as Omit<AuthMember, 'roles' | 'team_side'> | undefined;

      if (m) {
        areq.authMember = {
          ...m,
          roles: m.society_id === soc.id ? getMemberRoles(soc.id, m.id) : [],
          team_side: m.society_id === soc.id ? getMemberTeamSide(soc.id, m.id) : null,
        };
      }
    }
  }

  next();
}

export function requireAuth(req: Request, res: Response): AuthMember | null {
  const areq = req as AuthedRequest;
  if (!areq.authMember) {
    res.status(401).json({ code: 'UNAUTHORIZED', title: 'Please sign in with your mobile OTP first.' });
    return null;
  }
  return areq.authMember;
}

export function requireRole(
  req: Request,
  res: Response,
  allowedRoles: string[]
): AuthMember | null {
  const member = requireAuth(req, res);
  if (!member) return null;
  const areq = req as AuthedRequest;
  if (member.society_id !== areq.societyId) {
    res.status(403).json({
      code: 'CROSS_SOCIETY_FORBIDDEN',
      title: 'Officer actions are scoped strictly to your registered village society.',
    });
    return null;
  }
  const hasRole = member.roles.some((r) => allowedRoles.includes(r));
  if (!hasRole) {
    res.status(403).json({
      code: 'FORBIDDEN',
      title: `Required role: ${allowedRoles.join(' or ')}`,
    });
    return null;
  }
  return member;
}
