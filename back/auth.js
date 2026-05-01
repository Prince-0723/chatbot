import jwt from "jsonwebtoken";

export function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Put it in back/.env (example: ${name}=...) and re-run.`
    );
  }
  return value;
}

export function signJwt(user) {
  const secret = assertEnv("JWT_SECRET");
  return jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
      picture: user.picture,
    },
    secret,
    { expiresIn: "7d" }
  );
}

export function authenticate(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Missing Authorization token" });
    return;
  }

  try {
    const secret = assertEnv("JWT_SECRET");
    const payload = jwt.verify(token, secret);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function maybeAuthenticate(req, _res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    req.user = null;
    next();
    return;
  }

  try {
    const secret = assertEnv("JWT_SECRET");
    req.user = jwt.verify(token, secret);
  } catch {
    req.user = null;
  }
  next();
}

