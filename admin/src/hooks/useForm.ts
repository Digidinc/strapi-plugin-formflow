import { useEffect, useState, useCallback } from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import { API, Form, FormPayload, ApiResponse } from '../utils/api';
import { toFormApiError } from '../utils/form-api-error';

export type { FormApiError } from '../utils/form-api-error';

export interface UseFormReturn {
  form: Form | null;
  isLoading: boolean;
  isSaving: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  createForm: (data: FormPayload) => Promise<Form>;
  updateForm: (data: Partial<FormPayload>) => Promise<Form>;
  deleteForm: () => Promise<void>;
}

/**
 * Hook for managing a single form
 * Provides CRUD operations for form creation and editing
 */
export const useForm = (documentId?: string): UseFormReturn => {
  const { get, post, put, del } = useFetchClient();
  const [form, setForm] = useState<Form | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchForm = useCallback(async () => {
    if (!documentId) {
      setForm(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await get<ApiResponse<Form>>(API.form(documentId));
      setForm(response.data.data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch form';
      setError(new Error(errorMessage));
      setForm(null);
    } finally {
      setIsLoading(false);
    }
  }, [get, documentId]);

  useEffect(() => {
    if (documentId) {
      fetchForm();
    }
  }, [documentId, fetchForm]);

  const createForm = useCallback(
    async (data: FormPayload): Promise<Form> => {
      setIsSaving(true);
      setError(null);

      try {
        const response = await post<ApiResponse<Form>>(API.forms, data);
        const newForm = response.data.data;
        setForm(newForm);
        return newForm;
      } catch (err) {
        const error = toFormApiError(err, 'Failed to create form');
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [post]
  );

  const updateForm = useCallback(
    async (data: Partial<FormPayload>): Promise<Form> => {
      if (!documentId) {
        throw new Error('Cannot update form without documentId');
      }

      setIsSaving(true);
      setError(null);

      try {
        const response = await put<ApiResponse<Form>>(API.form(documentId), data);
        const updatedForm = response.data.data;
        setForm(updatedForm);
        return updatedForm;
      } catch (err) {
        const error = toFormApiError(err, 'Failed to update form');
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [put, documentId]
  );

  const deleteForm = useCallback(async (): Promise<void> => {
    if (!documentId) {
      throw new Error('Cannot delete form without documentId');
    }

    setIsSaving(true);
    setError(null);

    try {
      await del(API.form(documentId));
      setForm(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete form';
      const error = new Error(errorMessage);
      setError(error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  }, [del, documentId]);

  return {
    form,
    isLoading,
    isSaving,
    error,
    refetch: fetchForm,
    createForm,
    updateForm,
    deleteForm,
  };
};
