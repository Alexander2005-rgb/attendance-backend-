const express = require('express');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();


// Get attendance (students see their own, faculty and exam cell see all)
// Supports optional query params: date (ISO string), classPeriod (1-6), year, class
router.get('/', auth, async (req, res) => {
  try {
    const { date, classPeriod, year, class: studentClass } = req.query;
    const query = {};

    if (date) {
      // Parse date as local start of day
      const start = new Date(date);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }

    if (classPeriod) {
      query.classPeriod = Number(classPeriod);
    }

    const studentMatch = {};
    if (year) studentMatch.year = Number(year);
    if (studentClass) studentMatch.class = studentClass;
    if (req.query.rollNumber) studentMatch.rollNumber = req.query.rollNumber;

    if (req.user.role === 'faculty' || req.user.role === 'exam cell') {
      let attendance = await Attendance.find(query)
        .populate({
          path: 'student',
          select: 'name email class year rollNumber',
          match: studentMatch
        })
        .populate('markedBy', 'rollNumber')
        .catch(err => {
          console.error('Population error:', err);
          return [];
        });

      // Filter out attendance where student is null due to match
      attendance = attendance.filter(att => att.student !== null);

      console.log('Sending attendance data to frontend:', JSON.stringify(attendance, null, 2)); // Debug log
      res.json(attendance);
    } else {
      query.student = req.user.id;
      const attendance = await Attendance.find(query)
        .populate('student', 'name email class year rollNumber')
        .populate('markedBy', 'rollNumber')
        .catch(err => {
          console.error('Population error:', err);
          return [];
        });

      console.log('Sending attendance data to frontend:', JSON.stringify(attendance, null, 2)); // Debug log
      res.json(attendance);
    }
  } catch (err) {
    console.error('Error in attendance route:', err);
    res.status(500).send('Server error');
  }
});

// Mark attendance (for face detection, but here manual for now)
router.post('/', auth, async (req, res) => {
  const { studentId, date, status, classPeriod } = req.body;
  try {
    if (req.user.role !== 'faculty') return res.status(403).json({ msg: 'Access denied' });

    // Normalize date to start of day local
    const dateObj = new Date(date);

    // Get current time
    const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });

    let attendance = await Attendance.findOne({ student: studentId, date: dateObj, classPeriod });
    if (attendance) {
      attendance.status = status;
      attendance.time = currentTime; // Store current time when marking attendance
      attendance.markedBy = req.user.id;
      await attendance.save();
    } else {
      attendance = new Attendance({ student: studentId, date: dateObj, time: currentTime, status, markedBy: req.user.id, classPeriod });
      await attendance.save();
    }
    res.json(attendance);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Update attendance (faculty only)
router.put('/:id', auth, async (req, res) => {
  const { status } = req.body;
  try {
    if (req.user.role !== 'faculty') return res.status(403).json({ msg: 'Access denied' });

    const attendance = await Attendance.findById(req.params.id);
    if (!attendance) return res.status(404).json({ msg: 'Attendance not found' });

    attendance.status = status;
    attendance.markedBy = req.user.id;
    await attendance.save();
    res.json(attendance);
  } catch (err) {
    res.status(500).send('Server error');
  }
});



// Mark attendance from face detection (no auth needed for simplicity, or add API key)
router.post('/mark', async (req, res) => {
  console.log('Received attendance mark request:', req.body);
  const { rollNumber, date, time, status, classPeriod } = req.body;
  try {
    const user = await User.findOne({ rollNumber });
    if (!user) {
      console.log('User not found:', rollNumber);
      return res.status(404).json({ msg: 'User not found' });
    }

    // Normalize date to start of day local
    const dateObj = new Date(date);

    let attendance = await Attendance.findOne({ student: user._id, date: dateObj, classPeriod });
    if (attendance) {
      attendance.status = status;
      attendance.time = time; // Update time when status changes
    } else {
      attendance = new Attendance({ student: user._id, date: dateObj, time, status, classPeriod });
    }
    await attendance.save();

    // After marking present, mark absent for students in the same class who don't have a record
    if (status === 'present') {
      const studentsInClass = await User.find({ role: 'student', class: user.class, year: user.year });
      for (const student of studentsInClass) {
        const existingAttendance = await Attendance.findOne({ student: student._id, date: dateObj, classPeriod });
        if (!existingAttendance) {
          const absentAttendance = new Attendance({
            student: student._id,
            date: dateObj,
            time: '00:00:00', // Default time for auto-absent
            status: 'absent',
            classPeriod,
            markedBy: null // Auto-marked
          });
          await absentAttendance.save();
          console.log(`Auto-marked absent for student: ${student.name}`);
        }
      }
    }

    res.json(attendance);
  } catch (err) {
    console.error('Error in /mark route:', err);
    res.status(500).send('Server error');
  }
});



// Get all students
router.get('/students', auth, async (req, res) => {
  try {
    const { year, class: studentClass } = req.query;
    const query = { role: 'student' };
    if (year) query.year = Number(year);
    if (studentClass) query.class = studentClass;
    // Include class and year fields in the select
    const students = await User.find(query).select('name email class year rollNumber');
    res.json(students);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Get attendance for a specific student by roll number (for charting)
router.get('/student/:rollNumber', auth, async (req, res) => {
  try {
    const { rollNumber } = req.params;
    const { startDate, endDate } = req.query;

    // Find the student by roll number
    const student = await User.findOne({ rollNumber, role: 'student' });
    if (!student) {
      return res.status(404).json({ msg: 'Student not found' });
    }

    // Build query for attendance
    const query = { student: student._id };
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }

    const attendance = await Attendance.find(query).sort({ date: 1 });
    res.json(attendance);
  } catch (err) {
    console.error('Error fetching student attendance:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
