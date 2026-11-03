import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Members } from '../src/routes/members.js';
import { listMembers, setMemberRoles } from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  listMembers: vi.fn(),
  setMemberRoles: vi.fn(),
}));

const listMock = vi.mocked(listMembers);
const saveMock = vi.mocked(setMemberRoles);

describe('Members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists members and saves roles', async () => {
    listMock.mockResolvedValue([
      {
        userId: 'u-1',
        username: 'sre-dba',
        displayName: 'SRE DBA',
        status: 'active',
        roles: ['sre_duty'],
      },
    ]);
    saveMock.mockResolvedValue({
      userId: 'u-1',
      username: 'sre-dba',
      displayName: 'SRE DBA',
      status: 'active',
      roles: ['sre_duty', 'dba'],
    });
    render(<Members onBack={vi.fn()} />);
    expect(await screen.findByText(/SRE DBA/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('dba'));
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('u-1', ['sre_duty', 'dba']));
  });
});
