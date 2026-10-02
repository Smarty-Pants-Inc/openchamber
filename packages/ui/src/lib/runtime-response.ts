import { assertRuntimeRequestScope, type RuntimeRequestScope } from './runtime-switch';

// Response headers can arrive before a switch while the body is still pending.
// Guard the standard buffered readers, including SDK text parsing and clones.
// Streaming consumers retain their own event-pipeline generation checks.
export const guardRuntimeReadResponse = (response: Response, scope: RuntimeRequestScope): Response => {
  const guard = <T>(read: () => Promise<T>) => async (): Promise<T> => {
    assertRuntimeRequestScope(scope);
    const value = await read();
    assertRuntimeRequestScope(scope);
    return value;
  };
  response.json = guard(response.json.bind(response));
  response.text = guard(response.text.bind(response));
  response.arrayBuffer = guard(response.arrayBuffer.bind(response));
  response.blob = guard(response.blob.bind(response));
  response.formData = guard(response.formData.bind(response));
  const clone = response.clone.bind(response);
  response.clone = () => guardRuntimeReadResponse(clone(), scope);
  return response;
};
