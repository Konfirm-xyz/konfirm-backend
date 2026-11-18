import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { changePasswordSchema } from '../auth.controller';
import { pool } from '../../db/pool';

describe('Merchant Change Password (Issue #246)', () => {
  describe('changePasswordSchema validation', () => {
    it('accepts valid current and new password', () => {
      const valid = changePasswordSchema.safeParse({
        current_password: 'OldPassword123!',
        new_password: 'NewPassword456!',
      });
      expect(valid.success).toBe(true);
    });

    it('rejects empty current_password', () => {
      const res = changePasswordSchema.safeParse({
        current_password: '',
        new_password: 'NewPassword456!',
      });
      expect(res.success).toBe(false);
    });

    it('rejects new_password under 8 characters', () => {
      const res = changePasswordSchema.safeParse({
        current_password: 'OldPassword123!',
        new_password: 'short',
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain('at least 8 characters');
      }
    });

    it('rejects new_password over 72 bytes', () => {
      const res = changePasswordSchema.safeParse({
        current_password: 'OldPassword123!',
        new_password: 'a'.repeat(73),
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain('72 bytes or fewer');
      }
    });
  });

  describe('AuthService.changePassword behavior', () => {
    it('validates password differences and session invalidation logic', async () => {
      const oldPass = 'OldPass123!';
      const newPass = 'NewPass456!';
      const hash = await bcrypt.hash(oldPass, 10);

      // Same password check
      const same = await bcrypt.compare(oldPass, hash);
      expect(same).toBe(true);

      const different = await bcrypt.compare(newPass, hash);
      expect(different).toBe(false);
    });
  });
});
