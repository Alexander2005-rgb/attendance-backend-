const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

const router = express.Router();

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const rollNumber = req.body.rollNumber || 'unknown';
    cb(null, `${rollNumber}.jpg`);
  }
});

const upload = multer({ storage });

// Register
router.post('/register', upload.single('photo'), async (req, res) => {
  const { name, email, password, role, class: studentClass, year, rollNumber } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    const photoPath = req.file ? req.file.filename : null;

    user = new User({
      name,
      email,
      password,
      role,
      class: studentClass,
      year,
      rollNumber,
      photo: photoPath
    });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    await user.save();

    res.json({ msg: 'User registered successfully' });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });

    const payload = { user: { id: user.id, role: user.role } };
    jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: 3600 }, (err, token) => {
      if (err) throw err;
      res.json({ token, role: user.role });
    });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Update user (exam cell only)
router.put('/users/:id', auth, upload.single('photo'), async (req, res) => {
  const { name, email, password, class: studentClass, year, rollNumber } = req.body;
  try {
    if (req.user.role !== 'exam cell') return res.status(403).json({ msg: 'Access denied' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    // Update fields
    if (name) user.name = name;
    if (email) user.email = email;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
    }
    if (studentClass) user.class = studentClass;
    if (year) user.year = year;
    if (rollNumber) user.rollNumber = rollNumber;

    await user.save();
    res.json({ msg: 'User updated successfully' });
  } catch (err) {
    res.status(500).send('Server error');
  }
});

module.exports = router;
