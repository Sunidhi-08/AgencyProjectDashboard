import { createHash } from 'node:crypto';
import { PrismaClient, Role, TaskStatus, Priority, ActivityType } from '@prisma/client';

const prisma = new PrismaClient();
const passwordHash = createHash('sha256').update('password123').digest('hex');

async function main() {
	await prisma.activity.deleteMany();
	await prisma.notification.deleteMany();
	await prisma.refreshToken.deleteMany();
	await prisma.task.deleteMany();
	await prisma.project.deleteMany();
	await prisma.client.deleteMany();
	await prisma.user.deleteMany();

	const [admin, pmOne, pmTwo, devOne, devTwo, devThree, devFour] = await Promise.all([
		prisma.user.create({ data: { name: 'Asha Admin', email: 'admin@agency.com', passwordHash, role: Role.ADMIN } }),
		prisma.user.create({ data: { name: 'Ravi Manager', email: 'pm@agency.com', passwordHash, role: Role.PM } }),
		prisma.user.create({ data: { name: 'Maya Manager', email: 'pm2@agency.com', passwordHash, role: Role.PM } }),
		prisma.user.create({ data: { name: 'Dev One', email: 'dev@agency.com', passwordHash, role: Role.DEVELOPER } }),
		prisma.user.create({ data: { name: 'Dev Two', email: 'dev2@agency.com', passwordHash, role: Role.DEVELOPER } }),
		prisma.user.create({ data: { name: 'Dev Three', email: 'dev3@agency.com', passwordHash, role: Role.DEVELOPER } }),
		prisma.user.create({ data: { name: 'Dev Four', email: 'dev4@agency.com', passwordHash, role: Role.DEVELOPER } }),
	]);
	const clients = await Promise.all(['Northstar Labs', 'Monsoon Retail', 'Cedar Finance'].map((name, index) => prisma.client.create({ data: { name, email: `client${index + 1}@example.com` } })));
	const projects = await Promise.all([
		prisma.project.create({ data: { name: 'Northstar portal', clientId: clients[0].id, managerId: pmOne.id, creatorId: pmOne.id } }),
		prisma.project.create({ data: { name: 'Monsoon commerce', clientId: clients[1].id, managerId: pmOne.id, creatorId: pmOne.id } }),
		prisma.project.create({ data: { name: 'Cedar reporting', clientId: clients[2].id, managerId: pmTwo.id, creatorId: pmTwo.id } }),
	]);
	const developers = [devOne, devTwo, devThree, devFour];
	const statuses = [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.TODO];
	const priorities = [Priority.CRITICAL, Priority.HIGH, Priority.MEDIUM, Priority.LOW, Priority.HIGH];
	let taskCount = 0;
	let overdueCount = 0;
	let activityCount = 0;
	for (const [projectIndex, project] of projects.entries()) {
		for (let taskIndex = 0; taskIndex < 5; taskIndex += 1) {
			const overdue = projectIndex === 0 && taskIndex < 2;
			taskCount += 1;
			if (overdue) overdueCount += 1;
			const task = await prisma.task.create({ data: {
				projectId: project.id,
				title: `Task ${projectIndex * 5 + taskIndex + 1}`,
				description: `Deliverable for ${project.name}`,
				developerId: developers[(projectIndex + taskIndex) % developers.length].id,
				status: statuses[taskIndex], priority: priorities[taskIndex],
				dueDate: new Date(Date.now() + (overdue ? -2 : taskIndex + 1) * 86400000), overdue,
			} });
			if (taskIndex === 0) {
				await prisma.activity.create({ data: { type: ActivityType.TASK_STATUS_CHANGED, message: `Ravi moved ${task.title} from todo to in_progress`, userId: project.managerId, projectId: project.id, taskId: task.id, from: TaskStatus.TODO, to: TaskStatus.IN_PROGRESS, createdAt: new Date(Date.now() - 3600000) } });
				activityCount += 1;
			}
		}
	}
	const roleCounts = await prisma.user.groupBy({ by: ['role'], _count: { _all: true } });
	const expectedRoles = new Map(roleCounts.map((row) => [row.role, row._count._all]));
	if (expectedRoles.get(Role.ADMIN) !== 1 || expectedRoles.get(Role.PM) !== 2 || expectedRoles.get(Role.DEVELOPER) !== 4) throw new Error('Seed role counts do not match the assignment contract');
	if (projects.length < 3 || taskCount < 15 || overdueCount < 2 || activityCount === 0) throw new Error('Seed data does not satisfy the assignment contract');
	console.log(`Seeded ${projects.length} projects, ${taskCount} tasks (${overdueCount} overdue), ${activityCount} activity entries, and ${roleCounts.reduce((total, row) => total + row._count._all, 0)} users.`);
}

main().finally(() => prisma.$disconnect());
