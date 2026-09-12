import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import { Server } from 'socket.io';
import { Prisma, PrismaClient, Role, TaskStatus } from '@prisma/client';
import { z } from 'zod';

const app = express();
const port = Number(process.env.PORT ?? 4000);
const prisma = new PrismaClient();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: process.env.CLIENT_ORIGIN, credentials: true } });

type Session = { id: number; role: Role; name: string; email: string };
type AuthRequest = Request & { user?: Session };
const accessSecret = process.env.JWT_ACCESS_SECRET ?? 'development-access-secret';
const refreshSecret = process.env.JWT_REFRESH_SECRET ?? 'development-refresh-secret';
const refreshCookie = 'agency_refresh_token';
const isProduction = process.env.NODE_ENV === 'production';

const projectInput = z.object({ name: z.string().trim().min(1).max(120), clientId: z.coerce.number().int().positive(), managerId: z.coerce.number().int().positive().optional() });
const taskInput = z.object({ projectId: z.coerce.number().int().positive(), title: z.string().trim().min(1).max(160), description: z.string().trim().max(4000).default(''), developerId: z.coerce.number().int().positive().nullable().optional(), status: z.nativeEnum(TaskStatus).optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'), dueDate: z.coerce.date() });
const statusInput = z.object({ status: z.nativeEnum(TaskStatus) });

const error = (status: number, message: string) => Object.assign(new Error(message), { status });
const asyncRoute = (fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => void fn(req, res, next).catch(next);
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const signAccess = (user: Session) => jwt.sign(user, accessSecret, { expiresIn: '15m' });
const publicUser = (user: Session) => ({ id: user.id, name: user.name, email: user.email, role: user.role.toLowerCase() });
function parseInput<T>(result: z.SafeParseReturnType<unknown, T>): T {
  if (!result.success) throw error(400, result.error.issues.map((issue) => issue.message).join(', '));
  return result.data;
}

function statusName(status: TaskStatus) {
  return status.toLowerCase();
}

function issueRefresh(user: Session, res: Response) {
  const token = jwt.sign({ sub: user.id }, refreshSecret, { expiresIn: '7d' });
  void prisma.refreshToken.create({ data: { tokenHash: hash(token), userId: user.id, expiresAt: new Date(Date.now() + 7 * 86400000) } });
  res.cookie(refreshCookie, token, { httpOnly: true, sameSite: isProduction ? 'none' : 'lax', secure: isProduction, maxAge: 7 * 86400000 });
}

function requireAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next(error(401, 'Authentication required'));
  try {
    req.user = jwt.verify(header.slice(7), accessSecret) as Session;
    next();
  } catch { next(error(401, 'Invalid or expired access token')); }
}

const allow = (...roles: Role[]) => (req: AuthRequest, _res: Response, next: NextFunction) =>
  req.user && roles.includes(req.user.role) ? next() : next(error(403, 'Insufficient permissions'));

async function canViewProject(user: Session, projectId: number) {
  if (user.role === Role.ADMIN) return true;
  if (user.role === Role.DEVELOPER) {
    return Boolean(await prisma.task.findFirst({ where: { projectId, developerId: user.id }, select: { id: true } }));
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { creatorId: true } });
  return Boolean(project && project.creatorId === user.id);
}

app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const body = req.body as { email?: string; password?: string };
  if (!body.email || !body.password) throw error(400, 'Email and password are required');
  const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
  if (!user || hash(body.password) !== user.passwordHash) throw error(401, 'Invalid credentials');
  const session: Session = { id: user.id, role: user.role, name: user.name, email: user.email };
  issueRefresh(session, res);
  res.json({ token: signAccess(session), user: publicUser(session) });
}));

app.post('/api/auth/refresh', asyncRoute(async (req, res) => {
  const token = req.cookies[refreshCookie];
  if (!token) throw error(401, 'Refresh token required');
  try {
    const payload = jwt.verify(token, refreshSecret) as unknown as { sub: number };
    const stored = await prisma.refreshToken.findFirst({ where: { tokenHash: hash(token), userId: Number(payload.sub), revokedAt: null, expiresAt: { gt: new Date() } }, include: { user: true } });
    if (!stored) throw error(401, 'Invalid refresh token');
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const session: Session = { id: stored.user.id, role: stored.user.role, name: stored.user.name, email: stored.user.email };
    issueRefresh(session, res);
    res.json({ token: signAccess(session), user: publicUser(session) });
  } catch (cause) { throw (cause as Error & { status?: number }).status ? cause : error(401, 'Invalid refresh token'); }
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = req.cookies[refreshCookie];
  if (token) await prisma.refreshToken.updateMany({ where: { tokenHash: hash(token) }, data: { revokedAt: new Date() } });
  res.clearCookie(refreshCookie);
  res.json({ ok: true });
}));

app.get('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({ user: publicUser(req.user!) });
}));

app.get('/api/users', requireAuth, allow(Role.ADMIN, Role.PM), asyncRoute(async (req, res) => {
  const users = await prisma.user.findMany({ where: req.user!.role === Role.PM ? { role: Role.DEVELOPER } : undefined, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true, role: true } });
  res.json(users.map((user) => ({ ...user, role: user.role.toLowerCase() })));
}));

app.post('/api/users', requireAuth, allow(Role.ADMIN), asyncRoute(async (req, res) => {
  const input = parseInput(z.object({ name: z.string().trim().min(2).max(100), email: z.string().email().transform((value) => value.toLowerCase()), password: z.string().min(8).max(128), role: z.nativeEnum(Role) }).safeParse(req.body));
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw error(409, 'A user with this email already exists');
  const created = await prisma.user.create({ data: { name: input.name, email: input.email, passwordHash: hash(input.password), role: input.role }, select: { id: true, name: true, email: true, role: true } });
  io.to('global:admin').emit('user:new', { ...created, role: created.role.toLowerCase() });
  res.status(201).json({ ...created, role: created.role.toLowerCase() });
}));

app.get('/api/clients', requireAuth, asyncRoute(async (_req, res) => {
  res.json(await prisma.client.findMany({ orderBy: { name: 'asc' } }));
}));

app.post('/api/clients', requireAuth, allow(Role.ADMIN), asyncRoute(async (req, res) => {
  const input = parseInput(z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().optional() }).safeParse(req.body));
  res.status(201).json(await prisma.client.create({ data: input }));
}));

app.patch('/api/users/:id/role', requireAuth, allow(Role.ADMIN), asyncRoute(async (req, res) => {
  const role = String(req.body.role ?? '').toUpperCase() as Role;
  if (!Object.values(Role).includes(role)) throw error(400, 'Invalid role');
  const userId = Number(req.params.id);
  const user = await prisma.user.update({ where: { id: userId }, data: { role }, select: { id: true, name: true, email: true, role: true } });
  await prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
  io.in(`user:${userId}`).disconnectSockets(true);
  res.json({ ...user, role: user.role.toLowerCase() });
}));

app.get('/api/projects', requireAuth, asyncRoute(async (req, res) => {
  const user = req.user!;
  const where: Prisma.ProjectWhereInput = user.role === Role.ADMIN ? {} : user.role === Role.DEVELOPER ? { tasks: { some: { developerId: user.id } } } : { creatorId: user.id };
  const projects = await prisma.project.findMany({ where, include: { client: true, manager: { select: { name: true } }, _count: { select: { tasks: true } }, tasks: { where: { status: TaskStatus.DONE }, select: { id: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(projects.map((project) => ({ id: project.id, name: project.name, client_id: project.clientId, client_name: project.client.name, manager_name: project.manager.name, task_count: project._count.tasks, done_count: project.tasks.length })));
}));

app.post('/api/projects', requireAuth, allow(Role.ADMIN, Role.PM), asyncRoute(async (req, res) => {
  const input = parseInput(projectInput.safeParse(req.body));
  const manager = req.user!.role === Role.PM ? req.user!.id : Number(input.managerId ?? req.user!.id);
  const managerUser = await prisma.user.findFirst({ where: { id: manager, role: Role.PM } });
  if (!managerUser) throw error(400, 'A project manager must be assigned');
  const project = await prisma.project.create({ data: { name: input.name, clientId: input.clientId, managerId: manager, creatorId: req.user!.id } });
  const activity = await prisma.activity.create({ data: { type: 'PROJECT_CREATED', message: `${req.user!.name} created project ${project.name}`, userId: req.user!.id, projectId: project.id } });
  const activityPayload = { ...activity, actor_name: req.user!.name };
  io.to('global:admin').emit('activity:new', activityPayload);
  io.to(`user:${req.user!.id}`).emit('activity:new', activityPayload);
  io.to('global:admin').emit('project:new', project);
  io.to(`user:${req.user!.id}`).emit('project:new', project);
  res.status(201).json(project);
}));

app.post('/api/tasks', requireAuth, allow(Role.ADMIN, Role.PM), asyncRoute(async (req, res) => {
  const input = parseInput(taskInput.safeParse(req.body));
  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw error(404, 'Project not found');
  if (req.user!.role === Role.PM && project.creatorId !== req.user!.id) throw error(403, 'You cannot add tasks to this project');
  if (input.developerId) {
    const developer = await prisma.user.findFirst({ where: { id: input.developerId, role: Role.DEVELOPER } });
    if (!developer) throw error(400, 'Assigned user must be a developer');
  }
  const task = await prisma.task.create({ data: { projectId: input.projectId, title: input.title, description: input.description, developerId: input.developerId ?? null, status: input.status ?? TaskStatus.TODO, priority: input.priority, dueDate: input.dueDate } });
  await prisma.activity.create({ data: { type: 'TASK_ASSIGNED', message: `${req.user!.name} created ${task.title}`, userId: req.user!.id, projectId: task.projectId, taskId: task.id } });
  if (task.developerId) {
    await prisma.notification.create({ data: { userId: task.developerId, message: `${task.title} was assigned to you` } });
    io.to(`user:${task.developerId}`).emit('notification:new', { unread: await prisma.notification.count({ where: { userId: task.developerId, readAt: null } }) });
  }
  const taskActivity = await prisma.activity.findFirst({ where: { taskId: task.id }, orderBy: { createdAt: 'desc' } });
  if (taskActivity) {
    const payload = { ...taskActivity, actor_name: req.user!.name };
    io.to('global:admin').emit('activity:new', payload);
    io.to(`project:${task.projectId}`).emit('activity:new', payload);
  }
  io.to(`project:${task.projectId}`).emit('task:new', task);
  res.status(201).json(task);
}));

app.get('/api/tasks', requireAuth, asyncRoute(async (req, res) => {
  const user = req.user!;
  const where: Prisma.TaskWhereInput = user.role === Role.ADMIN ? {} : user.role === Role.DEVELOPER ? { developerId: user.id } : { project: { creatorId: user.id } };
  if (req.query.status) where.status = String(req.query.status).toUpperCase() as TaskStatus;
  if (req.query.priority) where.priority = String(req.query.priority).toUpperCase() as Prisma.EnumPriorityFilter;
  if (req.query.from || req.query.to) where.dueDate = { ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}), ...(req.query.to ? { lte: new Date(String(req.query.to)) } : {}) };
  const tasks = await prisma.task.findMany({ where, include: { project: { select: { name: true } }, developer: { select: { id: true, name: true } } }, orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }] });
  res.json(tasks.map((task) => ({ ...task, status: statusName(task.status), priority: task.priority.toLowerCase(), project_name: task.project.name, assignee_id: task.developerId, assignee_name: task.developer?.name ?? null })));
}));

app.patch('/api/tasks/:id', requireAuth, asyncRoute(async (req, res) => {
  const taskId = Number(req.params.id);
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { project: true, developer: true } });
  if (!task) throw error(404, 'Task not found');
  const user = req.user!;
  const allowed = user.role === Role.ADMIN || (user.role === Role.PM && task.project.creatorId === user.id) || (user.role === Role.DEVELOPER && task.developerId === user.id);
  if (!allowed) throw error(403, 'You cannot modify this task');
  const nextStatus = parseInput(statusInput.safeParse({ status: String(req.body.status ?? task.status).toUpperCase() })).status;
  if (nextStatus === TaskStatus.OVERDUE) throw error(400, 'Overdue is managed by the scheduled job');
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.task.update({ where: { id: taskId }, data: { status: nextStatus, overdue: false } , include: { project: { select: { name: true } }, developer: { select: { id: true, name: true } } } });
    if (nextStatus !== task.status) await tx.activity.create({ data: { type: 'TASK_STATUS_CHANGED', message: `${user.name} moved ${task.title} from ${statusName(task.status)} to ${statusName(nextStatus)}`, userId: user.id, projectId: task.projectId, taskId, from: task.status, to: nextStatus } });
    if (task.developerId && nextStatus === TaskStatus.IN_REVIEW && task.project.managerId !== user.id) await tx.notification.create({ data: { userId: task.project.managerId, message: `${task.title} is ready for review` } });
    return saved;
  });
  const activity = await prisma.activity.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } });
  if (activity && activity.userId === user.id) {
    const activityPayload = { ...activity, actor_name: user.name };
    io.to(`project:${task.projectId}`).emit('activity:new', activityPayload);
    io.to('global:admin').emit('activity:new', activityPayload);
    io.to(`user:${task.developerId ?? 0}`).emit('activity:new', activityPayload);
  }
  const taskPayload = { ...updated, status: statusName(updated.status), priority: updated.priority.toLowerCase(), assignee_id: updated.developerId, assignee_name: updated.developer?.name ?? null };
  io.to(`project:${task.projectId}`).emit('task:updated', taskPayload);
  io.to(`task:${taskId}`).emit('task:updated', taskPayload);
  if (nextStatus === TaskStatus.IN_REVIEW) io.to(`user:${task.project.managerId}`).emit('notification:new', { unread: await prisma.notification.count({ where: { userId: task.project.managerId, readAt: null } }) });
  res.json(updated);
}));

app.get('/api/activity', requireAuth, asyncRoute(async (req, res) => {
  const user = req.user!;
  const where: Prisma.ActivityWhereInput = user.role === Role.ADMIN ? {} : user.role === Role.DEVELOPER ? { task: { developerId: user.id } } : { project: { creatorId: user.id } };
  const activity = await prisma.activity.findMany({ where, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 });
  res.json(activity.map((item) => ({ ...item, actor_name: item.user.name })));
}));

app.get('/api/notifications', requireAuth, asyncRoute(async (req, res) => {
  const notifications = await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 30 });
  res.json({ items: notifications, unread: notifications.filter((item) => !item.readAt).length });
}));
app.patch('/api/notifications/:id/read', requireAuth, asyncRoute(async (req, res) => {
  const notification = await prisma.notification.updateMany({ where: { id: Number(req.params.id), userId: req.user!.id }, data: { readAt: new Date() } });
  if (!notification.count) throw error(404, 'Notification not found');
  io.to(`user:${req.user!.id}`).emit('notification:count', { unread: await prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }) });
  res.json({ ok: true });
}));
app.post('/api/notifications/read-all', requireAuth, asyncRoute(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
  io.to(`user:${req.user!.id}`).emit('notification:count', { unread: 0 });
  res.json({ ok: true });
}));

app.get('/api/dashboard/summary', requireAuth, asyncRoute(async (req, res) => {
  const user = req.user!;
  const scope: Prisma.TaskWhereInput = user.role === Role.ADMIN ? {} : user.role === Role.DEVELOPER ? { developerId: user.id } : { project: { creatorId: user.id } };
  const [tasks, overdue, projects] = await Promise.all([
    prisma.task.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.task.count({ where: { ...scope, overdue: true } }),
    prisma.project.count({ where: user.role === Role.ADMIN ? {} : user.role === Role.DEVELOPER ? { tasks: { some: { developerId: user.id } } } : { creatorId: user.id } }),
  ]);
  res.json({ projects, overdue, tasksByStatus: Object.fromEntries(tasks.map((item) => [item.status.toLowerCase(), item._count._all])), online: online.size });
}));

io.use((socket, next) => {
  try { socket.data.user = jwt.verify(String(socket.handshake.auth.token), accessSecret) as Session; next(); } catch { next(new Error('Unauthorized')); }
});
const online = new Map<number, number>();
io.on('connection', (socket) => {
  const user = socket.data.user as Session;
  socket.join(`user:${user.id}`);
  if (user.role === Role.ADMIN) socket.join('global:admin');
  online.set(user.id, (online.get(user.id) ?? 0) + 1);
  io.emit('presence:update', [...online.keys()].map((id) => ({ id })));
  socket.on('project:join', (projectId: number) => void canViewProject(user, projectId).then(async (ok) => {
    if (!ok) return;
    if (user.role === Role.DEVELOPER) {
      const assignedTasks = await prisma.task.findMany({ where: { projectId, developerId: user.id }, select: { id: true } });
      assignedTasks.forEach((task) => socket.join(`task:${task.id}`));
    } else {
      socket.join(`project:${projectId}`);
    }
  }));
  socket.on('disconnect', () => { const count = (online.get(user.id) ?? 1) - 1; count ? online.set(user.id, count) : online.delete(user.id); io.emit('presence:update', [...online.keys()].map((id) => ({ id }))); });
});

cron.schedule('0 * * * *', async () => {
  await prisma.task.updateMany({ where: { dueDate: { lt: new Date() }, overdue: false, status: { not: TaskStatus.DONE } }, data: { overdue: true } });
});

app.use((_req, _res, next) => next(error(404, 'Route not found')));
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

httpServer.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
