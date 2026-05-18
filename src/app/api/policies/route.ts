import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { PolicyRules } from '@/policy/types';

/**
 * POST /api/policies
 *
 * Create a new policy OR a new version of an existing one. Edits are
 * never destructive — they create a new row pointing back at the
 * parent, mark the new version active, and mark the previous one
 * inactive. Old versions stay queryable so sweeps that ran under them
 * can be audited cleanly.
 *
 *   curl -X POST http://localhost:3000/api/policies \
 *     -H "content-type: application/json" \
 *     -d '{
 *       "name":"weekly-sweep",
 *       "createdBy":"u_treasurer",
 *       "rules":{"rules":[
 *         {"kind":"minimum_balance","accountSelector":{"bankName":"HSBC"},"minimum":80000},
 *         {"kind":"sweep_surplus","source":{"currency":"GBP","minimumBuffer":80000},"target":{"accountType":"MMF"},"approvalRequiredAbove":50000}
 *       ]}
 *     }'
 */

export const runtime = 'nodejs';

const Body = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case name'),
  description: z.string().optional(),
  createdBy: z.string(),
  rules: PolicyRules,
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { name, description, createdBy, rules } = parsed.data;

  const newPolicy = await prisma.$transaction(async (tx) => {
    // Find the current active version, if any.
    const previous = await tx.policy.findFirst({
      where: { name, isActive: true },
      orderBy: { version: 'desc' },
    });

    if (previous) {
      await tx.policy.update({
        where: { id: previous.id },
        data: { isActive: false },
      });
    }

    return tx.policy.create({
      data: {
        name,
        description: description ?? null,
        version: (previous?.version ?? 0) + 1,
        parentPolicyId: previous?.id ?? null,
        rules: rules as never,
        createdBy,
        isActive: true,
      },
    });
  });

  return NextResponse.json({
    policyId: newPolicy.id,
    name: newPolicy.name,
    version: newPolicy.version,
  }, { status: 201 });
}
