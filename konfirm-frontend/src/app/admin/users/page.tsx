"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface AdminUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
  merchant_count: number;
  paid_count: number;
  held_count: number;
  disputed_count: number;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ users: AdminUser[] }>("/admin/users")
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load users");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="muted">Loading users…</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <div className="page">
      <h1>Users</h1>
      <table className="table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Merchants</th>
            <th>Paid</th>
            <th>Held</th>
            <th>Disputed</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.merchant_count}</td>
              <td>{u.paid_count}</td>
              <td>{u.held_count}</td>
              <td>{u.disputed_count}</td>
              <td>{new Date(u.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
