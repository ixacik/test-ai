import { NextRequest } from "next/server";
import OpenAI from "openai";

export const maxDuration = 120;

// Maximum file size: 10MB per file
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 50MB
// Maximum total upload size: 50MB
const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // 200MB

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const jsonHeaders = { "Content-Type": "application/json" };

export async function POST(req: NextRequest) {
  try {
    // Parse the form data using Web API
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (!files || files.length === 0) {
      return new Response(
        JSON.stringify({
          message:
            "No PDF files were uploaded. Please select at least one PDF file.",
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Validate file count
    if (files.length > 10) {
      return new Response(
        JSON.stringify({
          message: "Too many files. Please upload a maximum of 10 PDF files.",
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Validate files and calculate total size
    let totalSize = 0;
    for (const file of files) {
      // Check file type
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        return new Response(
          JSON.stringify({
            message: `File ${file.name} is not a PDF. Please upload only PDF files.`,
          }),
          {
            status: 400,
            headers: jsonHeaders,
          },
        );
      }

      // Check individual file size
      if (file.size > MAX_FILE_SIZE) {
        return new Response(
          JSON.stringify({
            message: `File ${file.name} is too large. Maximum file size is 10MB.`,
          }),
          {
            status: 400,
            headers: jsonHeaders,
          },
        );
      }

      totalSize += file.size;
    }

    // Check total upload size
    if (totalSize > MAX_TOTAL_SIZE) {
      return new Response(
        JSON.stringify({
          message: `Total upload size is too large. Maximum total size is 50MB.`,
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      );
    }

    // Create a new vector store
    const vectorStore = await client.vectorStores.create({
      name: `Quiz PDFs - ${new Date().toISOString()}`,
      expires_after: {
        anchor: "last_active_at",
        days: 7,
      },
    });

    // Upload files to OpenAI and collect file IDs
    const uploadedFileIds: string[] = [];

    try {
      for (const file of files) {
        try {
          // Upload file to OpenAI
          const uploadedFile = await client.files.create({
            file: file,
            purpose: "assistants",
          });

          uploadedFileIds.push(uploadedFile.id);
        } catch (fileUploadError) {
          console.error(`Failed to upload file ${file.name}:`, fileUploadError);
          throw new Error(
            `Failed to upload file ${file.name}. Please try again.`,
          );
        }
      }

      // Add all files to the vector store using batch create
      const batch = await client.vectorStores.fileBatches.createAndPoll(
        vectorStore.id,
        { file_ids: uploadedFileIds },
      );

      // Check if the batch was successful
      if (batch.status === "completed") {
        return new Response(
          JSON.stringify({
            vectorStoreId: vectorStore.id,
            message: `Successfully uploaded ${files.length} PDF files to vector store.`,
            filesUploaded: files.length,
            batchId: batch.id,
          }),
          {
            headers: jsonHeaders,
          },
        );
      } else if (batch.status === "failed") {
        // Clean up on failure
        await cleanupResources(vectorStore.id, uploadedFileIds);

        return new Response(
          JSON.stringify({
            message:
              "File upload batch failed. Please try again with different files.",
            details: batch,
          }),
          {
            status: 500,
            headers: jsonHeaders,
          },
        );
      } else {
        return new Response(
          JSON.stringify({
            message: `File upload is still in progress. Status: ${batch.status}`,
            vectorStoreId: vectorStore.id,
            batchId: batch.id,
          }),
          {
            headers: jsonHeaders,
          },
        );
      }
    } catch (uploadError) {
      // Clean up on error
      await cleanupResources(vectorStore.id, uploadedFileIds);
      throw uploadError;
    }
  } catch (error: unknown) {
    console.error("API Error in /api/upload:", error);

    let errorMessage = "An unexpected error occurred during file upload.";
    let statusCode = 500;

    if (error && typeof error === "object" && "message" in error) {
      errorMessage = (error as Error).message;
    }

    // Handle OpenAI API errors
    if (error && typeof error === "object" && "status" in error) {
      const openAIError = error as { status: number; message?: string };
      statusCode = openAIError.status;

      if (openAIError.status === 413 || errorMessage.includes("too large")) {
        errorMessage =
          "One or more files are too large. Please reduce file sizes and try again.";
        statusCode = 400;
      } else {
        errorMessage =
          openAIError.message || `OpenAI API Error: ${openAIError.status}`;
      }
    }

    // Handle specific error types
    if (
      errorMessage.includes("Request Entity Too Large") ||
      errorMessage.includes("413") ||
      statusCode === 413
    ) {
      errorMessage =
        "Files are too large. Please reduce file sizes and try again.";
      statusCode = 400;
    }

    // Ensure we always return a valid JSON response
    return new Response(
      JSON.stringify({
        message: errorMessage,
        error:
          process.env.NODE_ENV === "development"
            ? (error as Error)?.stack
            : undefined,
      }),
      {
        status: statusCode,
        headers: {
          ...jsonHeaders,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      },
    );
  }
}

// Handle CORS preflight requests
export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// Helper function to clean up resources on error
async function cleanupResources(vectorStoreId: string, fileIds: string[]) {
  // Clean up any uploaded files
  for (const fileId of fileIds) {
    try {
      await client.files.del(fileId);
    } catch (error) {
      console.warn(`Failed to delete OpenAI file ${fileId}:`, error);
    }
  }

  // Try to delete the vector store
  try {
    await client.vectorStores.del(vectorStoreId);
  } catch (error) {
    console.warn(`Failed to delete vector store ${vectorStoreId}:`, error);
  }
}
