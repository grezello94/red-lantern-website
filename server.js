const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin
// Make sure your downloaded JSON key is named 'firebase-key.json' and is in the same folder
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
const port = 3000;

// Serve your static HTML, CSS, and Image files
app.use(express.static(path.join(__dirname, '')));

// Middleware to parse form data from the admin dashboard
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Route for the home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route to view the admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Placeholder route to handle saving data from the admin dashboard
app.post('/api/update-home', async (req, res) => {
  const { heroTitle, heroSubtitle } = req.body;
  console.log('Received data to save to Firebase:', { heroTitle, heroSubtitle });

  try {
    // Save to Firestore 'home_content' collection, inside a document named 'main'
    await db.collection('home_content').doc('main').set({
      heroTitle,
      heroSubtitle
    }, { merge: true }); // merge: true ensures we update existing fields without overwriting the whole document
    
    res.send('<h2>Success!</h2><p>Home Page changes saved to Firebase.</p><a href="/admin">Go Back to Dashboard</a>');
  } catch (error) {
    console.error('Firebase error:', error);
    res.status(500).send('Database error: ' + error.message);
  }
});

app.listen(port, () => {
  console.log(`Red Lantern backend running at http://localhost:${port}`);
});