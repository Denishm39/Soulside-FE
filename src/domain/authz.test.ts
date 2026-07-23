import { describe, expect, it } from 'vitest';
import { allowed, can, type AuthContext, type Capability } from './authz.js';
import { ROLES, type Role } from './types.js';

const ctx = (role: Role, over: Partial<AuthContext> = {}): AuthContext => ({
  role,
  userId: `usr_${role}`,
  ...over,
});

describe('role capability matrix', () => {
  it('lets every role list and read notes', () => {
    for (const role of ROLES) {
      expect(allowed('notes.list', ctx(role))).toBe(true);
      expect(allowed('notes.read', ctx(role))).toBe(true);
      expect(allowed('audit.read', ctx(role))).toBe(true);
    }
  });

  it('only reviewers and admins can review', () => {
    expect(allowed('notes.review', ctx('REVIEWER'))).toBe(true);
    expect(allowed('notes.review', ctx('ADMIN'))).toBe(true);
    expect(allowed('notes.review', ctx('CLINICIAN'))).toBe(false);
  });

  it('only clinicians and admins can regenerate or amend', () => {
    for (const cap of ['notes.regenerate', 'notes.amend'] as Capability[]) {
      expect(allowed(cap, ctx('CLINICIAN'))).toBe(true);
      expect(allowed(cap, ctx('ADMIN'))).toBe(true);
      expect(allowed(cap, ctx('REVIEWER'))).toBe(false);
    }
  });
});

describe('READONLY_AUDITOR', () => {
  it('may read everything', () => {
    expect(allowed('notes.list', ctx('READONLY_AUDITOR'))).toBe(true);
    expect(allowed('audit.read', ctx('READONLY_AUDITOR'))).toBe(true);
  });

  it('may change nothing, with a read-only reason', () => {
    for (const cap of ['notes.edit', 'notes.review', 'notes.amend', 'notes.assignReviewer'] as Capability[]) {
      const d = can(cap, ctx('READONLY_AUDITOR'));
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe('read-only');
    }
  });
});

describe('ownership on review', () => {
  it('blocks a reviewer who is not the assignee once in review', () => {
    const d = can('notes.review', ctx('REVIEWER', { userId: 'usr_a', note: { status: 'IN_REVIEW', assignedReviewerId: 'usr_b' } }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('not-owner');
  });

  it('allows the assigned reviewer', () => {
    const d = can('notes.review', ctx('REVIEWER', { userId: 'usr_a', note: { status: 'IN_REVIEW', assignedReviewerId: 'usr_a' } }));
    expect(d.allowed).toBe(true);
  });

  it('lets any reviewer pick up a note that is only READY_FOR_REVIEW', () => {
    const d = can('notes.review', ctx('REVIEWER', { userId: 'usr_a', note: { status: 'READY_FOR_REVIEW', assignedReviewerId: null } }));
    expect(d.allowed).toBe(true);
  });
});

describe('denial distinguishes permission from data', () => {
  it('uses a machine-readable reason and a human message', () => {
    const d = can('notes.review', ctx('CLINICIAN'));
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe('no-permission'); // not "not-owner", not "wrong-status"
      expect(d.message.length).toBeGreaterThan(0);
    }
  });

  it('never throws for any role/capability pair', () => {
    const caps: Capability[] = [
      'notes.list',
      'notes.read',
      'notes.edit',
      'notes.review',
      'notes.regenerate',
      'notes.amend',
      'notes.assignReviewer',
      'audit.read',
    ];
    for (const role of ROLES) {
      for (const cap of caps) {
        expect(() => can(cap, ctx(role))).not.toThrow();
      }
    }
  });
});
