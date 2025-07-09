
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer  from 'multer'; 
import morgan from 'morgan';
import helmet from 'helmet';
import  { readFileSync, writeFileSync, existsSync } from 'fs';
import  { dirname, join } from 'path';
import  { fileURLToPath } from 'url';
import  { randomUUID }   from 'crypto';
const __dirname = dirname(fileURLToPath(import.meta.url));
port = process.env.PORT || 8000;

const upload = multer({
  dest: join(__dirname, 'uploads')  
});

const DB_PATH   = join(__dirname, 'data', 'db.json');

//import connectDB from './config/db.js';


const app = express();
//connectDB();


app.use(cors());
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

//app.use('/api/auth', authRoutes);



function loadDB() {
  if (!existsSync(DB_PATH)) writeFileSync(DB_PATH, JSON.stringify({ users: [], files: [], folders: [] }, null, 2));
  return JSON.parse(readFileSync(DB_PATH));
}

function saveDB(db) { 
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); 
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ msg: 'Missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(403).json({ msg: 'Invalid token' }); }
}


//Sign-up
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body;
  const db = loadDB();
  if (db.users.find(u => u.email === email))
    return res.status(409).json({ msg: 'Email already exists' });

  const user = {
    _id: randomUUID(),
    username,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    pin: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.users.push(user);
  saveDB(db);
  const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});


// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    return res.status(401).json({ msg: 'Bad credentials' });

  const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});



//Upload a file
app.post('/api/files', auth, upload.single('file'), (req, res) => {
  const db = loadDB();
  const meta = {
    _id: randomUUID(),
    name: req.file.originalname,
    type: req.body.type,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadDate: new Date().toISOString(),
    userId: req.user.id,
    folderId: req.body.folderId || null,
    path: req.file.path,
    isHidden: false,
    isFavorite: false,
    tags: []
  };
  db.files.push(meta);
  saveDB(db);
  res.json({ success: true, data: meta });
});


//List files with optional filters
app.get('/api/files', auth, (req, res) => {
  const { type, favorite, hidden, folderId } = req.query;
  let files = loadDB().files.filter(f => f.userId === req.user.id);

  if (type)     files = files.filter(f => f.type === type);
  if (favorite) files = files.filter(f => f.isFavorite === (favorite === 'true'));
  if (hidden)   files = files.filter(f => f.isHidden   === (hidden   === 'true'));
  if (folderId) files = files.filter(f => f.folderId   === folderId);

  res.json({ success: true, total: files.length, data: files });
});


//Toggle favourite
app.patch('/api/files/:id/favorite', auth, (req, res) => {
  const db = loadDB();
  const file = db.files.find(f => f._id === req.params.id && f.userId === req.user.id);
  if (!file) return res.status(404).json({ msg: 'Not found' });
  file.isFavorite = !file.isFavorite;
  saveDB(db);
  res.json({ success: true, isFavorite: file.isFavorite });
});

//Toggle hidden
app.patch('/api/files/:id/hidden', auth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u._id === req.user.id);
  if (user?.pin && req.body.pin !== user.pin)
    return res.status(401).json({ msg: 'Wrong PIN' });

  const file = db.files.find(f => f._id === req.params.id && f.userId === req.user.id);
  if (!file) return res.status(404).json({ msg: 'Not found' });
  file.isHidden = !file.isHidden;
  saveDB(db);
  res.json({ success: true, isHidden: file.isHidden });
});

//DASHBOARD ROUTES 
app.get('/api/dashboard/overview', auth, (req, res) => {
  const files = loadDB().files.filter(f => f.userId === req.user.id);
  const used   = files.reduce((s, f) => s + f.size, 0);
  const byType = ['image','pdf','note','folder'].reduce((o,t) => {
    o[t] = files.filter(f => f.type === t).reduce((s,f)=>s+f.size,0); return o;
  },{});
  const recent = files.sort((a,b)=> new Date(b.uploadDate)-new Date(a.uploadDate)).slice(0,10);
  res.json({ success:true, data:{ totalStorage: 1_000_000_000, usedStorage: used, byType, recent } });
});

//FAVORITES ROUTE
app.get('/api/favorites', auth, (req, res) => {
  const favs = loadDB().files.filter(f => f.userId === req.user.id && f.isFavorite);
  res.json({ success:true, total: favs.length, data: favs });
});

//CALENDAR ROUTES
app.get('/api/calendar/:year/:month', auth, (req,res) => {
  const { year, month } = req.params;
  const start = new Date(year, month, 1);
  const end   = new Date(year, Number(month)+1, 0);
  const files = loadDB().files.filter(f => f.userId===req.user.id &&
    new Date(f.uploadDate) >= start && new Date(f.uploadDate) <= end);

  const daysInMonth = end.getDate();
  const dayBuckets = {};
  files.forEach(f => {
    const key = f.uploadDate.slice(0,10);
    (dayBuckets[key] = dayBuckets[key] || []).push(f);
  });
  const days = Array.from({ length: daysInMonth }, (_,i) => {
    const d = String(i+1).padStart(2,'0');
    const full = `${year}-${String(Number(month)+1).padStart(2,'0')}-${d}`;
    return { date:i+1, fullDate:full, hasFiles:Boolean(dayBuckets[full]), fileCount: (dayBuckets[full]||[]).length };
  });
  res.json({ success:true, data:{ calendar:{ year:Number(year), month:Number(month), days }, files }});
});

//EXTRA AUTH ROUTES
app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body;
  const db   = loadDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ msg: 'User not found' });

  const code = String(Math.floor(100000 + Math.random() * 900000));      // 6-digit
  user.resetCodeHash   = await bcrypt.hash(code, 12);
  user.resetCodeExpiry = Date.now() + 2 * 60 * 1000;                     // 2 min
  saveDB(db);
  res.json({ msg: 'Code generated (dev only)', devCode: code });          // Send mail 
});

app.post('/api/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  const db   = loadDB();
  const user = db.users.find(u => u.email === email);
  if (!user || !user.resetCodeExpiry) return res.status(400).json({ msg: 'No code requested' });
  if (user.resetCodeExpiry < Date.now()) return res.status(400).json({ msg: 'Code expired' });
  if (!await bcrypt.compare(code, user.resetCodeHash)) return res.status(401).json({ msg: 'Invalid code' });

  user.codeVerified = true;
  saveDB(db);
  res.json({ msg: 'Code verified' });
});


app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  const db   = loadDB();
  const user = db.users.find(u => u.email === email);
  if (!user || !user.resetCodeExpiry) return res.status(400).json({ msg: 'No code requested' });
  if (user.resetCodeExpiry < Date.now()) return res.status(400).json({ msg: 'Code expired' });
  if (!await bcrypt.compare(code, user.resetCodeHash)) return res.status(401).json({ msg: 'Invalid code' });

  user.passwordHash   = await bcrypt.hash(newPassword, 12);
  user.resetCodeHash  = null;
  user.resetCodeExpiry = null;
  user.codeVerified   = false;
  saveDB(db);
  res.json({ msg: 'Password updated' });
});

app.patch('/api/auth/set-pin', auth, (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length < 4 || pin.length > 6) return res.status(400).json({ msg: 'PIN must be 4-6 digits' });
  const db   = loadDB();
  const user = db.users.find(u => u._id === req.user.id);
  user.pin = pin;
  saveDB(db);
  res.json({ msg: 'PIN set/updated' });
});

//FILE DETAIL ROUTES
app.get('/api/files/:id', auth, (req, res) => {
  const file = loadDB().files.find(f => f._id === req.params.id && f.userId === req.user.id);
  if (!file) return res.status(404).json({ msg: 'Not found' });
  res.json({ success: true, data: file });
});

app.patch('/api/files/:id', auth, (req, res) => {
  const { name } = req.body;
  const db   = loadDB();
  const file = db.files.find(f => f._id === req.params.id && f.userId === req.user.id);
  if (!file) return res.status(404).json({ msg: 'Not found' });
  file.name = name || file.name;
  saveDB(db);
  res.json({ success: true, data: file });
});

app.patch('/api/files/:id/move', auth, (req, res) => {
  const { folderId = null } = req.body;
  const db   = loadDB();
  const file = db.files.find(f => f._id === req.params.id && f.userId === req.user.id);
  if (!file) return res.status(404).json({ msg: 'Not found' });
  file.folderId = folderId;
  saveDB(db);
  res.json({ success: true, data: file });
});

app.delete('/api/files/:id', auth, (req, res) => {
  const db  = loadDB();
  const idx = db.files.findIndex(f => f._id === req.params.id && f.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ msg: 'Not found' });
  const [removed] = db.files.splice(idx, 1);
  saveDB(db);
  res.json({ success: true, deleted: removed._id });
});

// FOLDER ROUTES
app.post('/api/folders', auth, (req, res) => {
  const { name, parentId = null } = req.body;
  if (!name) return res.status(400).json({ msg: 'Name required' });
  const db = loadDB();
  const folder = { _id: randomUUID(), name, userId: req.user.id, parentId, isHidden: false, isFavorite: false };
  db.folders.push(folder);
  saveDB(db);
  res.json({ success: true, data: folder });
});

app.get('/api/folders/:id/children', auth, (req, res) => {
  const db = loadDB();
  res.json({
    success: true,
    data: {
      folders: db.folders.filter(f => f.parentId === req.params.id && f.userId === req.user.id),
      files:   db.files.filter(f   => f.folderId === req.params.id && f.userId === req.user.id)
    }
  });
});

app.patch('/api/folders/:id', auth, (req, res) => {
  const { name } = req.body;
  const db = loadDB();
  const folder = db.folders.find(f => f._id === req.params.id && f.userId === req.user.id);
  if (!folder) return res.status(404).json({ msg: 'Not found' });
  folder.name = name || folder.name;
  saveDB(db);
  res.json({ success: true, data: folder });
});

//Mark folder as favorite or hidden

['favorite', 'hidden'].forEach(flag => {
  app.patch(`/api/folders/:id/${flag}`, auth, (req, res) => {
    const db = loadDB();
    const folder = db.folders.find(f => f._id === req.params.id && f.userId === req.user.id);
    if (!folder) return res.status(404).json({ msg: 'Not found' });

    if (flag === 'hidden') {
      const user = db.users.find(u => u._id === req.user.id);
      if (user?.pin && req.body.pin !== user.pin) return res.status(401).json({ msg: 'Wrong PIN' });
      folder.isHidden = !folder.isHidden;
      return saveDB(db), res.json({ success: true, isHidden: folder.isHidden });
    }

    folder.isFavorite = !folder.isFavorite;
    saveDB(db);
    res.json({ success: true, isFavorite: folder.isFavorite });
  });
});

//Delete folder and all its contents
app.delete('/api/folders/:id', auth, (req, res) => {
  const db = loadDB();
  const idsToRemove = [];
  (function collect(id) {
    idsToRemove.push(id);
    db.folders.filter(f => f.parentId === id).forEach(sub => collect(sub._id));
  })(req.params.id);

  db.folders = db.folders.filter(f => !idsToRemove.includes(f._id));
  db.files   = db.files.filter(f => !idsToRemove.includes(f.folderId));
  saveDB(db);
  res.json({ success: true, deleted: idsToRemove.length });
});

// CALENDAR & SEARCH
app.get('/api/calendar/files', auth, (req, res) => {
  const { date, startDate, endDate } = req.query;
  let files = loadDB().files.filter(f => f.userId === req.user.id);

  if (date) {
    const d0 = new Date(date); const d1 = new Date(date); d1.setDate(d1.getDate() + 1);
    files = files.filter(f => new Date(f.uploadDate) >= d0 && new Date(f.uploadDate) < d1);
  } else if (startDate && endDate) {
    files = files.filter(f => new Date(f.uploadDate) >= new Date(startDate) &&
                              new Date(f.uploadDate) <= new Date(endDate));
  }
  res.json({ success: true, total: files.length, data: files });
});



//STATS
app.get('/api/stats/usage', auth, (req, res) => {
  const files = loadDB().files.filter(f => f.userId === req.user.id);
  const used  = files.reduce((sum, f) => sum + f.size, 0);
  res.json({ success: true, data: { quota: 1_000_000_000, used } });
});

app.get('/api/stats/type-breakdown', auth, (req, res) => {
  const files = loadDB().files.filter(f => f.userId === req.user.id);
  const breakdown = {};
  files.forEach(f => breakdown[f.type] = (breakdown[f.type] || 0) + f.size);
  res.json({ success: true, data: breakdown });
});


//START
app.listen(port, () => console.log(`API server ready on http://localhost:${port}`));





app.listen(process.env.PORT, () =>
  console.log(`Server running on ${process.env.PORT}`)
);
