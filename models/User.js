const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['student', 'faculty', 'exam cell'], required: true },
  class: { type: String, required: false }, // Added class field for grouping
  year: { type: Number, enum: [1, 2, 3, 4], required: false }, // Added year field for student's year
  rollNumber: { type: String, required: false }, // Added roll number field
  photo: { type: String, required: false } // Added photo field for storing photo path
});

module.exports = mongoose.model('User', userSchema);
