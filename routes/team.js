const express = require('express');
const router = express.Router();

router.get('/:seniorId', (req, res) => {
  res.json({ senior: { id: req.params.seniorId }, members: [] });
});

module.exports = router;
