// #1135: actual Web Files + runtimeFetch, with only fetch/DOM/object-URL seams.
// This is binary adapter coverage, not a served route, browser, or native proof.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { createWebFilesAPI } from './files';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Synthetic, connected one-sheet OOXML ZIP generated with the existing fflate
// dependency. Embedded bytes avoid adding a Web dependency just for the fixture.
const workbookBytes = Uint8Array.from(Buffer.from(
  'UEsDBBQAAAAIAAAAIVAcdPw42QAAAPYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2RvW7DMAyEX8XQWkRMO3Qo4ixt17ZDX4CV6Viw/iAyqfv2lZWfIUgyZSIk3t13AFfff4m4mbwL3KpBJL0AsBnII+uYKJRNH7NHKc+8gYRmxA3B03L5DCYGoSALmTPUevVGPW6dNO9T+WYbQ6syOVbN6144s1qFKTlrUMoedqE7oywOBF2cVcODTfxQBAouEubNdcDB97mjnG1HzRdm+UBfVDA5+I15/Ilx1LdDLrSMfW8NddFsfbFoTpmw44FIvNN1ao82HHvf4FcxQx2Pdy5yyj/2gHru9T9QSwMEFAAAAAgAAAAhUMoxNDKIAAAA9AAAAAsAAABfcmVscy8ucmVsc43PPQ4CIRAF4KsQDrCzsbAwC5WNrfECiMNP+BkCGNfbS2PiGgvLybx8L285Y1TdU27Ol8bWFHMT3PVeDgBNO0yqTVQwj4+hmlQfZ7VQlA7KIuzmeQ/10+ByY7LTTfAH1XAlCpxdngX/8ckYr/FI+p4w9x81X4khq2qxC75GeNdNA+UgF9iMlC9QSwMEFAAAAAgAAAAhUIwRuNKXAAAA7gAAAA8AAAB4bC93b3JrYm9vay54bWyNj7EOwjAMRH8lygdgysBQtR0QC58RUpdETezIDgL+nqqlO5N9d9I7Xfdime/Ms3nnRNrbUGtpAdQHzE4PXJCWZGLJri5SHqBF0I0aEGtOcDoez5BdJLsRWvmHwdMUPV7ZPzNS3SCCydXIpCEWtUO3NujvGnIZe3uJ5ORjPFMVTtas2W3sbWONtHF5VqexMHSwA2DfOHwBUEsDBBQAAAAIAAAAIVBrHuy5iwAAAPMAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHONzz0KAjEQBeCrhBxgZ7WwkE0qG1vxAiFOftjND5kR9fYGBXHBwnLmwfd40wkXw7FkCrGSuKclk5KBue4ByAZMhoZSMffElZYM97N5qMbOxiNsx3EH7duQemWK40VJCoi8keL8qPiPXpyLFg/FXhNm/lECt9Lml9pR0zyykp8Xwbtv6KoEPcFqo34CUEsDBBQAAAAIAAAAIVDaUS3OcwAAAJgAAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sTU5dCsIwDL7K6AHMHOKDdAXBi4Rarbi0JQmbxzfbw9hDwvcLn18qfyWnpN2PpiKjy6rtBiAxJ0I51ZaKOa/KhGqU3yCNEz63Ek0w9P0VCD/FBb9pD1QMnuvS8ejOpsYV3Fc0h8vgYQ4eop1F7B86sI8Jf1BLAQIUABQAAAAIAAAAIVAcdPw42QAAAPYBAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAAAAhUMoxNDKIAAAA9AAAAAsAAAAAAAAAAAAAAAAACgEAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgAAAAhUIwRuNKXAAAA7gAAAA8AAAAAAAAAAAAAAAAAuwEAAHhsL3dvcmtib29rLnhtbFBLAQIUABQAAAAIAAAAIVBrHuy5iwAAAPMAAAAaAAAAAAAAAAAAAAAAAH8CAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUABQAAAAIAAAAIVDaUS3OcwAAAJgAAAAYAAAAAAAAAAAAAAAAAEIDAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAUABQBFAQAA6wMAAAAA',
  'base64',
));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const previousResolver = getRuntimeUrlResolver();
const requests: Request[] = [];
const blobs: Blob[] = [];
const anchor = { href: '', download: '', click: vi.fn() };
const appendChild = vi.fn();
const removeChild = vi.fn();
let directory = '/workspace/财务 & #1';
let responseStatus: 200 | 403 | 404 | 500 = 200;
let responseMime = XLSX_MIME;

beforeEach(() => {
  requests.length = 0;
  blobs.length = 0;
  directory = '/workspace/财务 & #1';
  responseStatus = 200;
  responseMime = XLSX_MIME;
  anchor.href = '';
  anchor.download = '';
  vi.clearAllMocks();
  vi.useFakeTimers();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.invalid' });
  vi.stubGlobal('window', { location: { origin: 'https://ui.invalid', href: 'https://ui.invalid/' } });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', {
    createElement: vi.fn(() => anchor),
    body: { appendChild, removeChild },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init));
    return new Response(workbookBytes, { status: responseStatus, headers: { 'Content-Type': responseMime } });
  }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (!(blob instanceof Blob)) throw new Error('Download did not supply a binary Blob');
    blobs.push(blob);
    return 'blob:unit-download';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  setRuntimeUrlResolver(previousResolver);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('#1135 XLSX download through actual createWebFilesAPI and runtimeFetch', () => {
  it.each([XLSX_MIME, 'application/octet-stream'])('preserves original bytes, hash and %s MIME while encoding file and directory scope exactly once', async (mime) => {
    responseMime = mime;
    const api = createWebFilesAPI({ getDirectory: () => directory });
    if (!api.downloadFile) throw new Error('Web Files download capability is absent');
    await api.downloadFile('\\workspace\\财务 & #1\\October + %.XLSX');
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://runtime.invalid/api/fs/raw?path=%2Fworkspace%2F%E8%B4%A2%E5%8A%A1+%26+%231%2FOctober+%2B+%25.XLSX&download=true');
    expect(requests[0].headers.get('x-opencode-directory')).toBe(encodeURIComponent(directory));
    expect(requests[0].headers.get('x-opencode-directory-encoding')).toBe('uri');
    const query = new URL(requests[0].url).searchParams;
    expect(query.get('path')).toBe('/workspace/财务 & #1/October + %.XLSX');
    expect(Array.from(query.keys())).toEqual(['path', 'download']);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe(mime);
    const downloaded = new Uint8Array(await blobs[0].arrayBuffer());
    expect(downloaded).toEqual(workbookBytes);
    expect(hash(downloaded)).toBe(hash(workbookBytes));
    expect(anchor.download).toBe('October + %.XLSX');
    expect(anchor.href).toBe('blob:unit-download');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledWith(anchor);
    await vi.advanceTimersByTimeAsync(100);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:unit-download');
  });

  it('reads the current directory at download time, retaining plain ASCII hints', async () => {
    const api = createWebFilesAPI({ getDirectory: () => directory });
    if (!api.downloadFile) throw new Error('Web Files download capability is absent');
    directory = '/workspace/current & 100%';
    await api.downloadFile('/workspace/current & 100%/output.xlsx');
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('x-opencode-directory')).toBe(directory);
    expect(requests[0].headers.has('x-opencode-directory-encoding')).toBe(false);
    expect(new URL(requests[0].url).searchParams.get('path')).toBe(`${directory}/output.xlsx`);
  });

  const refusals: Array<403 | 404 | 500> = [403, 404, 500];
  for (const status of refusals) {
    it(`HTTP ${status} remains a refusal, without publishing or clicking a download`, async () => {
      responseStatus = status;
      const api = createWebFilesAPI({ getDirectory: () => directory });
      if (!api.downloadFile) throw new Error('Web Files download capability is absent');
      await expect(api.downloadFile(`${directory}/output.xlsx`)).rejects.toThrow(`Download failed (${status})`);
      expect(requests).toHaveLength(1);
      expect(blobs).toHaveLength(0);
      expect(anchor.click).not.toHaveBeenCalled();
      expect(appendChild).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
  }
});
