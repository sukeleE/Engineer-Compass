import { Router } from 'express';
import { authRequired } from './middleware.js';
import { issueRealtimeTicket } from '../lib/realtime.js';

const r = Router();

r.get('/ticket', authRequired, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(issueRealtimeTicket(req.user.id));
});

export default r;
