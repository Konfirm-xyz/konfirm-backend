import { HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter';
import * as sentry from './sentry';

function makeHost(statusFn: jest.Mock, jsonFn: jest.Mock): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({
        status: statusFn,
        json: jsonFn,
      }),
    }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;
  let captureSpy: jest.SpyInstance;

  beforeEach(() => {
    const logger = { setContext: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
    filter = new AllExceptionsFilter(logger);
    statusMock = jest.fn().mockReturnThis();
    jsonMock = jest.fn();
    captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes HttpException through unchanged without calling captureException', () => {
    const exc = new HttpException({ message: 'not found', custom: 'data' }, HttpStatus.NOT_FOUND);
    const host = makeHost(statusMock, jsonMock);

    filter.catch(exc, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonMock).toHaveBeenCalledWith(exc.getResponse());
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('returns generic 500 for non-HttpException and calls captureException', () => {
    const err = new Error('db connection lost');
    const host = makeHost(statusMock, jsonMock);

    filter.catch(err, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(jsonMock).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'internal server error',
    });
    expect(captureSpy).toHaveBeenCalledWith(err);
  });

  it('does not leak the original error message in the 500 response', () => {
    const err = new Error('SELECT * FROM users -- internal detail');
    const host = makeHost(statusMock, jsonMock);

    filter.catch(err, host);

    const responseBody = jsonMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(responseBody)).not.toContain('internal detail');
    expect(responseBody.message).toBe('internal server error');
  });

  it('handles thrown non-Error values (string, number, null)', () => {
    const host = makeHost(statusMock, jsonMock);

    filter.catch('something went wrong', host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captureSpy).toHaveBeenCalledWith('something went wrong');
  });
});
