import {
	type ImageData,
	ImageMediaType,
	MAX_IMAGE_BASE64_LENGTH,
	MAX_IMAGES_PER_MESSAGE,
} from "@repo/contracts/AgentSession";
import { Schema } from "effect";

export interface DraftImage extends ImageData {
	readonly id: string;
	// An object URL for the thumbnail. Revoke it when the image leaves the draft.
	readonly previewUrl: string;
}

export { MAX_IMAGES_PER_MESSAGE };

const isImageMediaType = Schema.is(ImageMediaType);

const readBase64 = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});

let nextImage = 0;

// For an image the daemon hands back, like one of a queued message a stop dropped.
export const draftImageOf = ({ mediaType, base64 }: ImageData): DraftImage => {
	const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	const previewUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
	return { id: `image-${++nextImage}`, mediaType, base64, previewUrl };
};

// Turns pasted, dropped or picked files into draft images, with a reason for each file left out.
export const readImages = async (files: ReadonlyArray<File>, room: number) => {
	const images: Array<DraftImage> = [];
	const problems: Array<string> = [];
	for (const file of files) {
		const mediaType = file.type;
		if (!isImageMediaType(mediaType)) {
			problems.push(`${file.name} is not a PNG, JPEG, GIF or WebP image.`);
			continue;
		}
		if (images.length >= room) {
			problems.push(`A message can carry ${MAX_IMAGES_PER_MESSAGE} images at most.`);
			break;
		}
		// Base64 is 4 characters per 3 bytes. Checking the size first keeps a huge file from being read at all.
		if (Math.ceil(file.size / 3) * 4 > MAX_IMAGE_BASE64_LENGTH) {
			problems.push(`${file.name} is larger than 5 MB.`);
			continue;
		}
		const base64 = await readBase64(file);
		images.push({ id: `image-${++nextImage}`, mediaType, base64, previewUrl: URL.createObjectURL(file) });
	}
	return { images, problems };
};
