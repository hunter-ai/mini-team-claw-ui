import { prisma } from "@/lib/prisma";

export type AdminUserView = {
  id: string;
  username: string;
  role: "ADMIN" | "MEMBER";
  openclawAgentId: string;
  isActive: boolean;
  oidcBinding: {
    issuer: string;
    linkedAt: string;
  } | null;
};

function serializeAdminUser(user: {
  id: string;
  username: string;
  role: "ADMIN" | "MEMBER";
  openclawAgentId: string;
  isActive: boolean;
  identities: Array<{ issuer: string; createdAt: Date }>;
}): AdminUserView {
  const identity = user.identities[0] ?? null;

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    openclawAgentId: user.openclawAgentId,
    isActive: user.isActive,
    oidcBinding: identity
      ? {
          issuer: identity.issuer,
          linkedAt: identity.createdAt.toISOString(),
        }
      : null,
  };
}

export async function getAdminUsers() {
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
      identities: {
        where: { provider: "oidc" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          issuer: true,
          createdAt: true,
        },
      },
    },
  });

  return users.map(serializeAdminUser);
}
