const PORTS = { iam: 3001, user: 3002, rider: 3004 }, S = Date.now();
let failures = 0;
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); if (!ok) failures++; };
const api = async (svc, path, method = 'GET', body, token) => {
  const r = await fetch(`http://localhost:${PORTS[svc]}${path}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, 150)); } return last; };
const signup = async (name, role) => (await api('iam', '/signup', 'POST', { name, email: `${name}${S}@t.com`, password: 'secret1', role })).body;
const HITEC = { lat: 17.4435, lng: 78.3772, label: 'HITEC' }, CHARMINAR = { lat: 17.3616, lng: 78.4747, label: 'Charminar' }, AIRPORT = { lat: 17.2403, lng: 78.4294, label: 'Airport' };
const rideOf = (p, id) => api('user', '/rides/' + id, 'GET', null, p.token).then(r => r.body);
const meOf = (r) => api('rider', '/me', 'GET', null, r.token).then(r => r.body);

(async () => {
  // --- IAM
  const dup = await api('iam', '/signup', 'POST', { name: 'x', email: `dup${S}@t.com`, password: 'secret1', role: 'rider' });
  const dup2 = await api('iam', '/signup', 'POST', { name: 'x', email: `DUP${S}@t.com`, password: 'secret1', role: 'rider' });
  check('signup ok', dup.status === 201); check('duplicate email (case-insens) -> 409', dup2.status === 409, dup2.status);
  check('short password -> 400', (await api('iam', '/signup', 'POST', { name: 'a', email: 'a@b.co', password: '123', role: 'rider' })).status === 400);
  check('wrong password -> 401', (await api('iam', '/login', 'POST', { email: `dup${S}@t.com`, password: 'nope' })).status === 401);
  check('login ok', (await api('iam', '/login', 'POST', { email: `dup${S}@t.com`, password: 'secret1' })).status === 200);

  const near = await signup('near', 'rider'), far = await signup('far', 'rider');
  const [p1, p2, p3, p4] = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(n => signup(n, 'passenger')));
  check('passenger cannot use rider endpoint -> 403', (await api('rider', '/online', 'POST', HITEC, p1.token)).status === 403);
  check('no token -> 401', (await api('user', '/rides', 'GET')).status === 401);

  await api('rider', '/online', 'POST', HITEC, near.token);        // near the pickup
  await api('rider', '/online', 'POST', CHARMINAR, far.token);     // far from the pickup
  await new Promise(r => setTimeout(r, 800));

  // --- happy path with a rejection in the middle
  const ride = (await api('user', '/rides', 'POST', { pickup: HITEC, dropoff: AIRPORT }, p1.token)).body;
  check('ride created as REQUESTED', ride.status === 'REQUESTED' && ride.id, JSON.stringify(ride));
  check('2nd concurrent request by same passenger -> 409', (await api('user', '/rides', 'POST', { pickup: HITEC, dropoff: AIRPORT }, p1.token)).status === 409);
  const assigned = await waitFor(async () => { const r = await rideOf(p1, ride.id); return r.status === 'ASSIGNED' && r; });
  check('nearest rider assigned', assigned && assigned.rider_id === near.user.id, JSON.stringify(assigned));
  check('rider sees OFFERED + offer details', (await waitFor(async () => { const m = await meOf(near); return m.status === 'OFFERED' && m; }))?.current_offer?.rideId === ride.id);

  check('rider rejects', (await api('rider', '/offer/reject', 'POST', {}, near.token)).status === 200);
  const reassigned = await waitFor(async () => { const r = await rideOf(p1, ride.id); return r.rider_id === far.user.id && r; });
  check('re-dispatched to next nearest rider', !!reassigned, JSON.stringify(await rideOf(p1, ride.id)));
  check('double reject -> 409', (await api('rider', '/offer/reject', 'POST', {}, near.token)).status === 409);

  check('accept', (await api('rider', '/offer/accept', 'POST', {}, far.token)).status === 200);
  check('passenger sees ACCEPTED', !!(await waitFor(async () => (await rideOf(p1, ride.id)).status === 'ACCEPTED')));
  check('complete before start -> 409', (await api('rider', '/offer/complete', 'POST', {}, far.token)).status === 409);
  check('start', (await api('rider', '/offer/start', 'POST', {}, far.token)).status === 200);
  check('passenger sees IN_PROGRESS', !!(await waitFor(async () => (await rideOf(p1, ride.id)).status === 'IN_PROGRESS')));
  check('complete', (await api('rider', '/offer/complete', 'POST', { demoTripMinutes: 20 }, far.token)).status === 200);
  const done = await waitFor(async () => { const r = await rideOf(p1, ride.id); return r.status === 'COMPLETED' && r; });
  const km = assigned.distance_km, expected = Number(Math.max(80, 40 + km * 12 + 20 * 1.5).toFixed(2));
  check(`fare = base + km*12 + min*1.5 (expected ${expected})`, done && done.fare === expected, JSON.stringify(done));
  const farAfter = await waitFor(async () => { const m = await meOf(far); return m.last_fare && m; });
  check('rider sees last fare, is AVAILABLE at dropoff', farAfter?.last_fare === expected && farAfter.status === 'AVAILABLE' && Math.abs(farAfter.lat - AIRPORT.lat) < 1e-9, JSON.stringify(farAfter));
  check('passenger can request again after completion', (await api('user', '/rides', 'POST', { pickup: HITEC, dropoff: AIRPORT }, p1.token)).status === 201);

  // --- race: 3 passengers request at once, only 2 riders exist (p1's new ride also competes) -> exactly 2 assigned, rest NO_RIDERS, never the same rider twice
  await new Promise(r => setTimeout(r, 1500));
  const rides = await Promise.all([p2, p3, p4].map(async p => ({ p, ride: (await api('user', '/rides', 'POST', { pickup: HITEC, dropoff: CHARMINAR }, p.token)).body })));
  await new Promise(r => setTimeout(r, 2500));
  const all = await Promise.all([...rides.map(r => rideOf(r.p, r.ride.id)), api('user', '/rides', 'GET', null, p1.token).then(r => r.body[0])]);
  const assignedNow = all.filter(r => r.status === 'ASSIGNED'), noRiders = all.filter(r => r.status === 'NO_RIDERS');
  const riderIds = assignedNow.map(r => r.rider_id);
  check('4 simultaneous requests, 2 riders -> 2 ASSIGNED, 2 NO_RIDERS', assignedNow.length === 2 && noRiders.length === 2, all.map(r => r.status).join());
  check('no rider double-booked', new Set(riderIds).size === riderIds.length, riderIds.join());

  check('invalid coordinates -> 400', (await api('user', '/rides', 'POST', { pickup: { lat: 999, lng: 0 }, dropoff: HITEC }, p2.token)).status === 400);
  check('malformed ride id -> 400', (await api('user', `/rides/${ride.id}abc`, 'GET', null, p2.token)).status === 400);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED'); process.exit(failures ? 1 : 0);
})();
