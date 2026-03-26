import { hash } from "@node-rs/argon2";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const bootstrapMode = process.env.ADMIN_BOOTSTRAP_MODE ?? "seed";
  if (bootstrapMode !== "seed") {
    console.log(`Skipping admin seed because ADMIN_BOOTSTRAP_MODE=${bootstrapMode}`);
    return;
  }

  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const agentId = process.env.SEED_ADMIN_AGENT_ID ?? "main";

  if (!username || !password) {
    console.error(
      "Skipping seed. Set SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD to create the initial admin.",
    );
    return;
  }

  const passwordHash = await hash(password);

  await prisma.user.upsert({
    where: { username },
    update: {
      passwordHash,
      role: UserRole.ADMIN,
      openclawAgentId: agentId,
      isActive: true,
    },
    create: {
      username,
      passwordHash,
      role: UserRole.ADMIN,
      openclawAgentId: agentId,
      isActive: true,
    },
  });

  console.log(`Seeded admin user ${username}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
