"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyRefreshToken = exports.verifyAccessToken = exports.signRefreshToken = exports.signAccessToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const AppError_1 = require("./AppError");
// Pin the signing/verification algorithm so a forged token that sets
// `"alg":"none"` (or asymmetric-key confusion) can never be accepted.
const JWT_ALG = 'HS256';
const signAccessToken = (payload) => {
    return jsonwebtoken_1.default.sign({ ...payload, type: 'access' }, env_1.env.JWT_ACCESS_SECRET, { expiresIn: env_1.env.JWT_ACCESS_EXPIRES_IN, algorithm: JWT_ALG });
};
exports.signAccessToken = signAccessToken;
const signRefreshToken = (payload) => {
    return jsonwebtoken_1.default.sign({ ...payload, type: 'refresh' }, env_1.env.JWT_REFRESH_SECRET, { expiresIn: env_1.env.JWT_REFRESH_EXPIRES_IN, algorithm: JWT_ALG });
};
exports.signRefreshToken = signRefreshToken;
const verifyAccessToken = (token) => {
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET, {
            algorithms: [JWT_ALG],
        });
        // Reject a refresh token presented where an access token is expected.
        if (payload.type !== 'access') {
            throw new AppError_1.AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
        }
        return payload;
    }
    catch (err) {
        if (err instanceof AppError_1.AppError)
            throw err;
        throw new AppError_1.AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
    }
};
exports.verifyAccessToken = verifyAccessToken;
const verifyRefreshToken = (token) => {
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_REFRESH_SECRET, {
            algorithms: [JWT_ALG],
        });
        if (payload.type !== 'refresh') {
            throw new AppError_1.AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
        }
        return payload;
    }
    catch (err) {
        if (err instanceof AppError_1.AppError)
            throw err;
        throw new AppError_1.AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }
};
exports.verifyRefreshToken = verifyRefreshToken;
//# sourceMappingURL=jwt.js.map